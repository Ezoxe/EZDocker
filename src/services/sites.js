const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const docker = require('./docker');
const proxy = require('./proxy');
const ports = require('./ports');
const stats = require('./stats');
const settings = require('./settings');
const notifier = require('./notifier');
const monitor = require('./monitor');
const { HttpError, nowIso, slugify, isValidSlug } = require('../util');

const siteDir = (id) => path.join(config.dataDir, 'sites', String(id));
const containerName = (site) => `ezd-${site.slug}`;

const UPDATABLE = new Set([
  'name', 'status', 'status_message', 'container_id', 'image', 'current_deployment_id', 'last_deployed_at',
  'detected_port', 'container_port', 'env_json', 'memory_mb', 'cpus',
]);

function get(id) {
  return db.get('SELECT * FROM sites WHERE id = ?', id) || null;
}

function findByRef(ref) {
  const value = String(ref);
  if (/^\d+$/.test(value)) return get(Number(value));
  return db.get('SELECT * FROM sites WHERE slug = ?', value.toLowerCase()) || null;
}

/** Returns the site if the user may manage it; 404 otherwise (do not leak existence). */
function assertAccess(user, site) {
  if (!site || (user.role !== 'superadmin' && site.owner_id !== user.id)) {
    throw new HttpError(404, 'Site introuvable.', 'SITE_NOT_FOUND');
  }
  return site;
}

function proxyMode(site) {
  if (site.status === 'stopped') return 'stopped';
  if (site.container_id) return 'proxy';
  if (site.status === 'deploying') return 'deploying';
  return 'pending';
}

function syncProxy(site) {
  return proxy.ensure({
    id: site.id,
    name: site.name,
    public_port: site.public_port,
    internal_port: ports.internalPort(site.public_port),
    mode: proxyMode(site),
  });
}

function update(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    db.run(
      `UPDATE sites SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => fields[k]), nowIso(), id
    );
  }
  const site = get(id);
  if (site) {
    proxy.setMode(site.id, proxyMode(site));
    notifier.bus.emit('site', { id: site.id, owner_id: site.owner_id });
  }
  return site;
}

function parseEnv(site) {
  try {
    return JSON.parse(site.env_json || '{}');
  } catch {
    return {};
  }
}

function serialize(site) {
  const host = settings.publicHost();
  const owner = db.get('SELECT username FROM users WHERE id = ?', site.owner_id);
  return {
    id: site.id,
    name: site.name,
    slug: site.slug,
    owner_id: site.owner_id,
    owner: owner ? owner.username : null,
    status: site.status,
    status_message: site.status_message,
    host,
    public_port: site.public_port,
    url: `http://${host}:${site.public_port}`,
    internal_port: ports.internalPort(site.public_port),
    container_port: site.container_port,
    detected_port: site.detected_port,
    effective_port: site.container_port || site.detected_port || null,
    container_name: containerName(site),
    container_id: site.container_id,
    image: site.image,
    env: parseEnv(site),
    memory_mb: site.memory_mb,
    cpus: site.cpus,
    current_deployment_id: site.current_deployment_id,
    total_requests: site.total_requests,
    last_access_at: site.last_access_at,
    created_at: site.created_at,
    updated_at: site.updated_at,
    last_deployed_at: site.last_deployed_at,
    proxy: proxy.status(site.id),
  };
}

function listFor(user) {
  return user.role === 'superadmin'
    ? db.all('SELECT * FROM sites ORDER BY name COLLATE NOCASE')
    : db.all('SELECT * FROM sites WHERE owner_id = ? ORDER BY name COLLATE NOCASE', user.id);
}

async function create({ actor, owner, name, slug }) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Le nom du site est obligatoire.');
  slug = slug ? String(slug).trim().toLowerCase() : slugify(name);
  if (!isValidSlug(slug)) {
    throw new HttpError(400, 'Identifiant invalide : lettres minuscules, chiffres et tirets (32 caractères max).');
  }
  if (db.get('SELECT 1 FROM sites WHERE slug = ?', slug)) throw new HttpError(409, `L'identifiant « ${slug} » est déjà utilisé.`, 'SLUG_TAKEN');

  if (owner.role !== 'superadmin') {
    const count = db.get('SELECT COUNT(*) n FROM sites WHERE owner_id = ?', owner.id).n;
    if (count >= owner.max_sites) {
      throw new HttpError(403, `Limite atteinte : ${owner.max_sites} site(s) maximum pour ce compte.`, 'SITE_LIMIT');
    }
  }

  const port = await ports.allocate();
  const now = nowIso();
  const isAdmin = owner.role === 'superadmin';
  const memoryMb = isAdmin ? Number(settings.get('default_memory_mb')) : owner.max_memory_mb;
  const cpus = isAdmin ? Number(settings.get('default_cpus')) : owner.max_cpus;
  const id = db.run(
    `INSERT INTO sites (owner_id, name, slug, public_port, memory_mb, cpus, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    owner.id, name, slug, port, memoryMb, cpus, now, now
  ).lastInsertRowid;
  const site = get(id);
  await syncProxy(site);
  notifier.emit('site.created', { site, actor, message: `Site ${name} créé sur le port ${port}` });
  return site;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validates and saves editable settings. Returns { site, needsRedeploy }. */
function updateSettings(site, body, actor) {
  const owner = db.get('SELECT * FROM users WHERE id = ?', site.owner_id);
  const isAdmin = actor.role === 'superadmin';
  const fields = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Le nom du site est obligatoire.');
    fields.name = name;
  }
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) throw new HttpError(400, 'Variables invalides.');
    const entries = Object.entries(body.env);
    if (entries.length > 100) throw new HttpError(400, '100 variables maximum.');
    const env = {};
    for (const [k, v] of entries) {
      if (!ENV_KEY.test(k)) throw new HttpError(400, `Nom de variable invalide : ${k}`);
      const value = String(v ?? '');
      if (value.length > 4096) throw new HttpError(400, `Valeur trop longue pour ${k}.`);
      env[k] = value;
    }
    fields.env_json = JSON.stringify(env);
  }
  if (body.container_port !== undefined) {
    if (body.container_port === null || body.container_port === '') fields.container_port = null;
    else {
      const p = Number(body.container_port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HttpError(400, 'Port du conteneur invalide.');
      fields.container_port = p;
    }
  }
  if (body.memory_mb !== undefined) {
    const m = Number(body.memory_mb);
    const max = isAdmin ? 65536 : owner.max_memory_mb;
    if (!Number.isInteger(m) || m < 32 || m > max) throw new HttpError(400, `Mémoire : entre 32 et ${max} Mo.`);
    fields.memory_mb = m;
  }
  if (body.cpus !== undefined) {
    const c = Number(body.cpus);
    const max = isAdmin ? 64 : owner.max_cpus;
    if (!Number.isFinite(c) || c < 0.1 || c > max) throw new HttpError(400, `CPU : entre 0.1 et ${max}.`);
    fields.cpus = Math.round(c * 100) / 100;
  }

  const runtimeKeys = ['env_json', 'container_port', 'memory_mb', 'cpus'];
  const needsRedeploy = !!site.image && runtimeKeys.some((k) => k in fields && String(fields[k]) !== String(site[k]));
  const updated = update(site.id, fields);
  if (fields.name) syncProxy(updated);
  return { site: updated, needsRedeploy };
}

async function start(site, actor) {
  if (!site.container_id) throw new HttpError(400, "Ce site n'a pas encore été déployé.");
  await docker.startContainer(site.container_id);
  const fresh = update(site.id, { status: 'running', status_message: null });
  notifier.emit('site.started', { site: fresh, actor, message: `${site.name} a été démarré` });
  return fresh;
}

async function stop(site, actor) {
  if (!site.container_id) throw new HttpError(400, "Ce site n'a pas encore été déployé.");
  monitor.markIntentional(site.container_id);
  await docker.stopContainer(site.container_id);
  const fresh = update(site.id, { status: 'stopped', status_message: null });
  notifier.emit('site.stopped', { site: fresh, actor, message: `${site.name} a été arrêté` });
  return fresh;
}

async function restart(site, actor) {
  if (!site.container_id) throw new HttpError(400, "Ce site n'a pas encore été déployé.");
  monitor.markIntentional(site.container_id);
  await docker.restartContainer(site.container_id);
  const fresh = update(site.id, { status: 'running', status_message: null });
  notifier.emit('site.started', { site: fresh, actor, message: `${site.name} a été redémarré` });
  return fresh;
}

async function remove(site, actor) {
  proxy.close(site.id);
  try {
    const containers = await docker.listSiteContainers();
    for (const c of containers) {
      if (c.Labels && c.Labels[docker.LABEL_SITE] === String(site.id)) {
        monitor.markIntentional(c.Id);
        await docker.removeContainer(c.Id);
      }
    }
    for (const img of await docker.listSiteImages(site.id)) await docker.removeImage(img.Id);
  } catch (err) {
    if (site.container_id) throw new HttpError(503, `Docker injoignable : ${err.message}`);
  }
  fs.rmSync(siteDir(site.id), { recursive: true, force: true });
  stats.forget(site.id);
  notifier.emit('site.deleted', { site: { ...site, status: 'deleted' }, actor, message: `${site.name} a été supprimé` });
  db.run('DELETE FROM sites WHERE id = ?', site.id);
  notifier.bus.emit('site', { id: site.id, owner_id: site.owner_id, deleted: true });
}

const statsCache = new Map();

async function runtime(site) {
  if (!site.container_id) return null;
  let info;
  try {
    info = await docker.inspectContainer(site.container_id);
  } catch (err) {
    return { exists: false, error: `Docker injoignable : ${err.message}` };
  }
  if (!info) return { exists: false };

  const nets = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
  const net = nets[docker.NETWORK] || Object.values(nets)[0] || {};
  let usage = null;
  if (info.State.Running) {
    const cached = statsCache.get(info.Id);
    if (cached && cached.at > Date.now() - 5000) usage = cached.value;
    else {
      try {
        usage = await docker.containerStats(info.Id);
        statsCache.set(info.Id, { at: Date.now(), value: usage });
      } catch {
        usage = null;
      }
    }
  }
  return {
    exists: true,
    id: info.Id,
    short_id: info.Id.slice(0, 12),
    name: info.Name.replace(/^\//, ''),
    state: info.State.Status,
    running: info.State.Running,
    started_at: info.State.StartedAt,
    finished_at: info.State.FinishedAt,
    exit_code: info.State.ExitCode,
    oom_killed: info.State.OOMKilled,
    restart_count: info.RestartCount,
    ip: net.IPAddress || null,
    network: docker.NETWORK,
    image: info.Config.Image,
    created_at: info.Created,
    stats: usage,
  };
}

/** Startup: listeners for every site + status alignment with Docker. */
async function bootstrap() {
  for (const site of db.all('SELECT * FROM sites')) {
    await syncProxy(site);
  }
}

module.exports = {
  siteDir,
  containerName,
  get,
  findByRef,
  assertAccess,
  update,
  serialize,
  listFor,
  create,
  updateSettings,
  start,
  stop,
  restart,
  remove,
  runtime,
  syncProxy,
  bootstrap,
  parseEnv,
};
