const fs = require('fs');
const http = require('http');
const path = require('path');
const config = require('../config');
const db = require('../db');
const docker = require('./docker');
const ports = require('./ports');
const sites = require('./sites');
const notifier = require('./notifier');
const monitor = require('./monitor');
const { extractZip } = require('./zip');
const { HttpError, nowIso, sleep, log } = require('../util');

const KIND_LABELS = {
  initial: 'mise en place',
  update: 'mise à jour',
  rebuild: 'reconstruction',
  rollback: 'restauration',
  config: 'nouvelle configuration',
};
const KEEP_VERSIONS = 3;
const MAX_LOG = 512 * 1024;
const BUILD_CACHE_MAX_AGE = '72h';

const queues = new Map(); // siteId -> tail promise
const pendingPerSite = new Map(); // siteId -> count of queued/running deployments
const live = new Map(); // deploymentId -> { log, step, status, done, listeners, persistTimer }

// --- Global build concurrency ---------------------------------------------
let runningBuilds = 0;
const waiting = [];
const acquire = () =>
  new Promise((resolve) => {
    if (runningBuilds < config.maxConcurrentBuilds) {
      runningBuilds++;
      resolve();
    } else waiting.push(resolve);
  });
function release() {
  const next = waiting.shift();
  if (next) next();
  else runningBuilds--;
}

const deployDir = (siteId, depId) => path.join(sites.siteDir(siteId), 'deploys', String(depId));

function getDeployment(id) {
  return db.get('SELECT * FROM deployments WHERE id = ?', id) || null;
}

function serialize(dep, { withLog = false } = {}) {
  if (!dep) return null;
  const state = live.get(dep.id);
  const out = {
    id: dep.id,
    site_id: dep.site_id,
    user_id: dep.user_id,
    username: dep.user_id ? db.get('SELECT username FROM users WHERE id = ?', dep.user_id)?.username || null : null,
    kind: dep.kind,
    kind_label: KIND_LABELS[dep.kind] || dep.kind,
    source: dep.source,
    status: dep.status,
    step: state ? state.step : dep.step,
    zip_name: dep.zip_name,
    zip_size: dep.zip_size,
    image: dep.image,
    error: dep.error,
    created_at: dep.created_at,
    started_at: dep.started_at,
    finished_at: dep.finished_at,
    duration_ms: dep.duration_ms,
  };
  if (withLog) out.log = state ? state.log : dep.log;
  return out;
}

function isBusy(siteId) {
  return (pendingPerSite.get(siteId) || 0) > 0;
}

// --- Live log streaming -----------------------------------------------------

function broadcast(state, data) {
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of state.listeners) res.write(line);
}

function persistLog(depId) {
  const state = live.get(depId);
  if (!state) return;
  clearTimeout(state.persistTimer);
  state.persistTimer = null;
  db.run('UPDATE deployments SET log = ? WHERE id = ?', state.log, depId);
}

function appendLog(depId, text) {
  const state = live.get(depId);
  if (!state || !text) return;
  state.log += text.endsWith('\n') ? text : text + '\n';
  if (state.log.length > MAX_LOG) state.log = '…(début du journal tronqué)…\n' + state.log.slice(-MAX_LOG + 1024);
  broadcast(state, { type: 'log', text: text.endsWith('\n') ? text : text + '\n' });
  if (!state.persistTimer) state.persistTimer = setTimeout(() => persistLog(depId), 1500);
}

function setStep(depId, step) {
  const state = live.get(depId);
  if (state) {
    state.step = step;
    broadcast(state, { type: 'step', step });
  }
  db.run('UPDATE deployments SET step = ? WHERE id = ?', step, depId);
}

function subscribe(depId, res) {
  const dep = getDeployment(depId);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const state = live.get(depId);
  res.write(`data: ${JSON.stringify({ type: 'init', deployment: serialize(dep, { withLog: true }) })}\n\n`);
  if (!state || state.done) {
    res.write(`data: ${JSON.stringify({ type: 'done', status: dep.status, error: dep.error })}\n\n`);
    return res.end();
  }
  state.listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    state.listeners.delete(res);
  });
}

// --- Queue -------------------------------------------------------------------

/**
 * Queues a deployment. kind: initial | update | rebuild | rollback | config.
 * zipPath: uploaded archive (moved into the deployment folder).
 * fromDeployment: reuse that deployment's archive (rebuild) or image (rollback/config).
 */
function enqueue({ site, actor, kind, source = 'web', zipPath = null, zipName = null, zipSize = null, image = null, fromDeployment = null }) {
  const depId = db.run(
    `INSERT INTO deployments (site_id, user_id, kind, source, status, step, zip_name, zip_size, image, created_at)
     VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?)`,
    site.id, actor ? actor.id : null, kind, source, zipName, zipSize, image, nowIso()
  ).lastInsertRowid;

  const dir = deployDir(site.id, depId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (zipPath) moveFile(zipPath, path.join(dir, 'source.zip'));
    else if (kind === 'rebuild' && fromDeployment) {
      const src = path.join(deployDir(site.id, fromDeployment.id), 'source.zip');
      if (!fs.existsSync(src)) throw new HttpError(410, "L'archive de la version actuelle n'est plus disponible.");
      fs.copyFileSync(src, path.join(dir, 'source.zip'));
      db.run('UPDATE deployments SET zip_name = ?, zip_size = ? WHERE id = ?', fromDeployment.zip_name, fromDeployment.zip_size, depId);
    }
  } catch (err) {
    db.run("UPDATE deployments SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", err.message, nowIso(), depId);
    throw err;
  }

  live.set(depId, { log: '', step: 'queued', status: 'queued', done: false, listeners: new Set(), persistTimer: null });
  pendingPerSite.set(site.id, (pendingPerSite.get(site.id) || 0) + 1);
  if (isBusy(site.id) && pendingPerSite.get(site.id) > 1) appendLog(depId, '⏳ En attente de la fin du déploiement précédent…');

  const previous = queues.get(site.id) || Promise.resolve();
  const task = previous
    .then(() => run(depId, actor))
    .catch((err) => log.error(`Déploiement #${depId}`, err))
    .finally(() => {
      pendingPerSite.set(site.id, pendingPerSite.get(site.id) - 1);
      if (queues.get(site.id) === task) queues.delete(site.id);
    });
  queues.set(site.id, task);
  return getDeployment(depId);
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: config.upstreamHost, port, path: '/', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function waitHttp(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await probeHttp(port);
    if (status) return status;
    await sleep(1000);
  }
  return null;
}

/** Replaces the site container. Restores the previous one if the new container does not stay up. */
async function swapContainer(site, image, containerPort, depId) {
  const name = sites.containerName(site);
  const tmpName = `${name}-previous`;
  const say = (t) => appendLog(depId, t);

  const leftover = await docker.inspectContainer(tmpName);
  if (leftover) {
    monitor.markIntentional(leftover.Id);
    await docker.removeContainer(leftover.Id);
  }

  const old = await docker.inspectContainer(name);
  const oldWasRunning = !!(old && old.State.Running);
  if (old) {
    await docker.renameContainer(old.Id, tmpName);
    if (oldWasRunning) {
      say('Arrêt de la version en ligne…');
      monitor.markIntentional(old.Id);
      await docker.stopContainer(old.Id, 10);
    }
  }

  let newId = null;
  try {
    say('Démarrage du nouveau conteneur…');
    newId = await docker.createSiteContainer({
      name,
      image,
      containerPort,
      internalPort: ports.internalPort(site.public_port),
      env: { PORT: String(containerPort), ...sites.parseEnv(site) },
      memoryMb: site.memory_mb,
      cpus: site.cpus,
      siteId: site.id,
      deploymentId: depId,
    });
    await sleep(3000);
    const info = await docker.inspectContainer(newId);
    if (!info || !info.State.Running || info.State.Restarting || info.RestartCount > 0) {
      const logs = await docker.containerLogs(newId, 40).catch(() => '');
      if (logs.trim()) say(`--- Journal du conteneur ---\n${logs.trimEnd()}\n----------------------------`);
      const state = info ? info.State : {};
      throw new Error(`Le conteneur s'est arrêté au démarrage (code ${state.ExitCode ?? '?'}${state.OOMKilled ? ', mémoire insuffisante' : ''}).`);
    }
  } catch (err) {
    if (newId) {
      monitor.markIntentional(newId);
      await docker.removeContainer(newId).catch(() => {});
    } else {
      const partial = await docker.inspectContainer(name).catch(() => null);
      if (partial && (!old || partial.Id !== old.Id)) await docker.removeContainer(partial.Id).catch(() => {});
    }
    if (old) {
      await docker.renameContainer(old.Id, name).catch(() => {});
      if (oldWasRunning) {
        await docker.startContainer(old.Id).catch(() => {});
        say('↺ La version précédente a été remise en ligne.');
      }
    }
    throw err;
  }

  if (old) {
    monitor.markIntentional(old.Id);
    await docker.removeContainer(old.Id).catch(() => {});
  }
  return newId;
}

async function run(depId, actor) {
  const dep = getDeployment(depId);
  let site = dep && sites.get(dep.site_id);
  const state = live.get(depId);
  if (!dep || !site) return;

  const started = Date.now();
  const previousStatus = site.status;
  const firstDeploy = !site.current_deployment_id;
  const kindLabel = KIND_LABELS[dep.kind] || dep.kind;
  const say = (t) => appendLog(depId, t);
  state.status = 'running';
  db.run("UPDATE deployments SET status = 'running', started_at = ? WHERE id = ?", nowIso(), depId);
  site = sites.update(site.id, { status: 'deploying' });
  notifier.emit('deployment.started', {
    site,
    deployment: getDeployment(depId),
    actor,
    message: `Déploiement #${depId} (${kindLabel}) de ${site.name} démarré`,
  });
  say(`▶ Déploiement #${depId} — ${kindLabel} de « ${site.name} »`);

  let image = dep.image;
  try {
    if (['initial', 'update', 'rebuild'].includes(dep.kind)) {
      setStep(depId, 'extract');
      const dir = deployDir(site.id, depId);
      const zipFile = path.join(dir, 'source.zip');
      if (!fs.existsSync(zipFile)) throw new Error('Archive introuvable.');
      const srcDir = path.join(dir, 'src');
      fs.rmSync(srcDir, { recursive: true, force: true });
      const { contextDir, dockerfile } = extractZip(zipFile, srcDir);
      const rel = path.relative(srcDir, path.join(contextDir, dockerfile)).replace(/\\/g, '/');
      say(`✓ Archive extraite : ${countFiles(contextDir)} fichier(s), Dockerfile : ${rel}`);

      setStep(depId, 'build');
      image = `ezdocker/${site.slug}:${depId}`;
      if (runningBuilds >= config.maxConcurrentBuilds) say('⏳ En attente d’un emplacement de build libre…');
      await acquire();
      try {
        say(`Construction de l'image ${image}…`);
        const build = () =>
          docker.buildImage(contextDir, {
            tag: image,
            dockerfile,
            labels: { [docker.LABEL_SITE]: String(site.id), [docker.LABEL_DEPLOYMENT]: String(depId) },
            onLog: say,
          });
        try {
          await build();
        } catch (err) {
          if (!docker.isNoSpaceError(err)) throw err;
          // A full disk is usually the build cache of earlier builds and the versions kept for restore
          // (once the cache is gone they no longer share layers): keep only the version online, retry once.
          say('⚠ Disque plein. Nettoyage du cache de build Docker et des anciennes versions de ce site…');
          const removed = await removeRestoreImages(site.id, site.image);
          const freed = await docker.pruneBuildSpace();
          if (removed) say(`✓ ${removed} ancienne(s) version(s) supprimée(s) : leur restauration ne sera plus possible.`);
          say(`✓ ${formatBytes(freed)} de cache libéré(s). Nouvelle tentative de construction…`);
          await build();
        }
      } catch (err) {
        if (docker.isNoSpaceError(err)) {
          throw new Error(
            `Espace disque insuffisant sur le serveur, même après nettoyage du cache de build. ` +
            `Libérez de la place (docker system df pour voir l'occupation) ou agrandissez le disque. Détail : ${err.message}`
          );
        }
        throw err;
      } finally {
        release();
        fs.rmSync(srcDir, { recursive: true, force: true });
      }
      db.run('UPDATE deployments SET image = ? WHERE id = ?', image, depId);
      say(`✓ Image construite : ${image}`);
    } else {
      if (!image || !(await docker.imageExists(image))) throw new Error("L'image de cette version n'existe plus.");
      say(`Réutilisation de l'image ${image}`);
    }

    setStep(depId, 'start');
    const detected = await docker.imageExposedPort(image);
    const containerPort = site.container_port || detected || 80;
    const origin = site.container_port ? 'défini dans les paramètres' : detected ? 'EXPOSE du Dockerfile' : 'par défaut';
    say(`Port de l'application dans le conteneur : ${containerPort} (${origin})`);
    const containerId = await swapContainer(site, image, containerPort, depId);
    site = sites.update(site.id, { container_id: containerId, image, detected_port: detected });

    setStep(depId, 'verify');
    const status = await waitHttp(ports.internalPort(site.public_port), 20000);
    if (status) say(`✓ L'application répond (HTTP ${status})`);
    else say(`⚠ L'application ne répond pas encore en HTTP sur le port ${containerPort}. Vérifiez le port d'écoute (EXPOSE).`);

    const finishedAt = nowIso();
    const duration = Date.now() - started;
    db.run(
      "UPDATE deployments SET status = 'success', step = 'done', finished_at = ?, duration_ms = ? WHERE id = ?",
      finishedAt, duration, depId
    );
    site = sites.update(site.id, {
      status: 'running',
      status_message: null,
      current_deployment_id: depId,
      last_deployed_at: finishedAt,
    });
    const url = sites.serialize(site).url;
    say(`✔ En ligne sur ${url} (${(duration / 1000).toFixed(1)} s)`);
    state.status = 'success';
    notifier.emit(firstDeploy ? 'site.deployed' : 'site.updated', {
      site,
      deployment: getDeployment(depId),
      actor,
      message: firstDeploy ? `${site.name} est en ligne sur ${url}` : `${site.name} a été mis à jour (${kindLabel})`,
    });
    cleanupVersions(site.id).catch((err) => log.warn('Nettoyage des versions', err.message));
  } catch (err) {
    let message = (err && (err.json && err.json.message)) || (err && err.message) || String(err);
    if (err && ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(err.code) && /docker|sock|pipe/i.test(message)) {
      message = `Docker est injoignable (${message}). Vérifiez que le service Docker tourne.`;
    }
    say(`✖ Échec : ${message}`);
    state.status = 'failed';
    db.run(
      "UPDATE deployments SET status = 'failed', error = ?, finished_at = ?, duration_ms = ? WHERE id = ?",
      message.slice(0, 2000), nowIso(), Date.now() - started, depId
    );
    const fresh = sites.get(site.id);
    let alive = false;
    if (fresh.container_id) {
      const info = await docker.inspectContainer(fresh.container_id).catch(() => null);
      alive = !!(info && info.State.Running);
    }
    let status = 'error';
    if (alive) status = 'running';
    else if (fresh.container_id && previousStatus === 'stopped') status = 'stopped';
    site = sites.update(site.id, { status, status_message: `Dernier déploiement échoué : ${message.slice(0, 300)}` });
    notifier.emit('site.deploy_failed', {
      site,
      deployment: getDeployment(depId),
      actor,
      message: `Échec du déploiement de ${site.name} : ${message.slice(0, 300)}`,
    });
  } finally {
    state.done = true;
    persistLog(depId);
    const final = getDeployment(depId);
    broadcast(state, { type: 'done', status: final.status, error: final.error });
    for (const res of state.listeners) res.end();
    state.listeners.clear();
    setTimeout(() => live.delete(depId), 30000).unref();
  }
}

/** Keeps the images and archives of the last successful versions only. */
async function cleanupVersions(siteId) {
  const keep = db
    .all("SELECT id, image FROM deployments WHERE site_id = ? AND status = 'success' AND image IS NOT NULL ORDER BY id DESC", siteId)
    .reduce((acc, d) => {
      if (acc.images.size < KEEP_VERSIONS && !acc.images.has(d.image)) acc.images.add(d.image);
      if (acc.images.has(d.image)) acc.ids.add(d.id);
      return acc;
    }, { images: new Set(), ids: new Set() });

  for (const img of await docker.listSiteImages(siteId)) {
    const tags = img.RepoTags || [];
    if (!tags.some((t) => keep.images.has(t))) await docker.removeImage(img.Id);
  }

  const base = path.join(sites.siteDir(siteId), 'deploys');
  if (!fs.existsSync(base)) return;
  for (const name of fs.readdirSync(base)) {
    const id = Number(name);
    if (keep.ids.has(id) || live.has(id)) continue;
    fs.rmSync(path.join(base, name), { recursive: true, force: true });
  }

  // Build cache left by old versions and failed builds; recent entries keep the next builds fast.
  await docker.pruneBuildSpace({ olderThan: BUILD_CACHE_MAX_AGE });
}

/** Removes the site's images except the one online. Returns how many were removed. */
async function removeRestoreImages(siteId, onlineImage) {
  let removed = 0;
  for (const img of await docker.listSiteImages(siteId)) {
    if ((img.RepoTags || []).includes(onlineImage)) continue;
    await docker.removeImage(img.Id);
    removed++;
  }
  return removed;
}

function formatBytes(bytes) {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

/** Deployments interrupted by a restart of EZDocker are marked as failed. */
function recoverInterrupted() {
  const rows = db.all("SELECT * FROM deployments WHERE status IN ('queued', 'running')");
  for (const dep of rows) {
    db.run(
      "UPDATE deployments SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      'Interrompu par un redémarrage d’EZDocker.', nowIso(), dep.id
    );
    const site = sites.get(dep.site_id);
    if (site && site.status === 'deploying') {
      sites.update(site.id, { status: site.container_id ? 'running' : 'error', status_message: 'Déploiement interrompu.' });
    }
  }
}

function listForSite(siteId, limit = 30) {
  return db.all('SELECT * FROM deployments WHERE site_id = ? ORDER BY id DESC LIMIT ?', siteId, limit).map((d) => serialize(d));
}

module.exports = {
  KIND_LABELS,
  enqueue,
  getDeployment,
  serialize,
  subscribe,
  isBusy,
  listForSite,
  recoverInterrupted,
  cleanupVersions,
  deployDir,
  formatBytes,
};
