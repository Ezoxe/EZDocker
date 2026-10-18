const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const sites = require('../services/sites');
const deployer = require('../services/deployer');
const stats = require('../services/stats');
const docker = require('../services/docker');
const settings = require('../services/settings');
const { HttpError } = require('../util');

const router = express.Router();
router.use(auth.requireAuth);

const tmpDir = path.join(config.dataDir, 'tmp');

function upload(req, res) {
  const maxMb = Number(settings.get('max_upload_mb')) || 200;
  const handler = multer({
    dest: tmpDir,
    limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 10 },
    fileFilter: (_req, file, cb) => {
      if (!/\.zip$/i.test(file.originalname)) return cb(new HttpError(400, 'Seuls les fichiers .zip sont acceptés.', 'NOT_ZIP'));
      cb(null, true);
    },
  }).single('file');
  return new Promise((resolve, reject) => {
    handler(req, res, (err) => {
      if (!err) return resolve(req.file);
      if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(413, `Archive trop volumineuse (max ${maxMb} Mo).`, 'TOO_LARGE'));
      if (err instanceof HttpError) return reject(err);
      reject(new HttpError(400, `Envoi invalide : ${err.message}`));
    });
  });
}

function load(req) {
  return sites.assertAccess(req.user, sites.findByRef(req.params.ref));
}

function ownerFor(req) {
  if (req.user.role === 'superadmin' && req.body?.owner_id) {
    const owner = db.get('SELECT * FROM users WHERE id = ?', Number(req.body.owner_id));
    if (!owner) throw new HttpError(400, 'Propriétaire introuvable.');
    return owner;
  }
  return req.user;
}

function ensureNotBusy(site) {
  if (deployer.isBusy(site.id)) throw new HttpError(409, 'Un déploiement est déjà en cours pour ce site.', 'BUSY');
}

router.get('/', (req, res) => {
  const list = sites.listFor(req.user).map((s) => ({ ...sites.serialize(s), stats: stats.summary(s.id) }));
  res.json({ sites: list });
});

router.post('/', async (req, res) => {
  const site = await sites.create({ actor: req.user, owner: ownerFor(req), name: req.body?.name, slug: req.body?.slug });
  res.status(201).json({ site: sites.serialize(site) });
});

router.get('/:ref', async (req, res) => {
  const site = load(req);
  res.json({
    site: sites.serialize(site),
    runtime: await sites.runtime(site),
    stats: stats.summary(site.id),
    busy: deployer.isBusy(site.id),
  });
});

router.patch('/:ref', (req, res) => {
  const site = load(req);
  const { site: updated, needsRedeploy } = sites.updateSettings(site, req.body || {}, req.user);
  let deployment = null;
  if (needsRedeploy && req.body?.apply !== false) {
    const current = updated.current_deployment_id && deployer.getDeployment(updated.current_deployment_id);
    deployment = deployer.enqueue({
      site: updated,
      actor: req.user,
      kind: 'config',
      source: req.authType === 'token' ? 'api' : 'web',
      image: updated.image,
      fromDeployment: current,
    });
  }
  res.json({ site: sites.serialize(sites.get(site.id)), deployment: deployer.serialize(deployment), needs_redeploy: needsRedeploy });
});

router.delete('/:ref', async (req, res) => {
  const site = load(req);
  ensureNotBusy(site);
  await sites.remove(site, req.user);
  res.json({ ok: true });
});

/**
 * Upload a .zip and deploy it. Usable from the panel or with an API token:
 *   curl -H "Authorization: Bearer ezd_..." -F file=@site.zip http://HOST/api/sites/my-site/deploy
 * Add ?create=1 to create the site on the fly when the slug does not exist yet.
 */
router.post('/:ref/deploy', async (req, res) => {
  let site = sites.findByRef(req.params.ref);
  if (!site && req.query.create === '1' && !/^\d+$/.test(req.params.ref)) {
    site = await sites.create({ actor: req.user, owner: req.user, name: req.params.ref, slug: req.params.ref });
  }
  sites.assertAccess(req.user, site);

  fs.mkdirSync(tmpDir, { recursive: true });
  const file = await upload(req, res);
  if (!file) throw new HttpError(400, 'Aucun fichier reçu (champ « file »).', 'NO_FILE');

  const fresh = sites.get(site.id);
  const deployment = deployer.enqueue({
    site: fresh,
    actor: req.user,
    kind: fresh.current_deployment_id ? 'update' : 'initial',
    source: req.authType === 'token' ? 'api' : 'web',
    zipPath: file.path,
    zipName: file.originalname.slice(0, 200),
    zipSize: file.size,
  });
  res.status(202).json({ deployment: deployer.serialize(deployment), site: sites.serialize(fresh) });
});

router.post('/:ref/rebuild', (req, res) => {
  const site = load(req);
  const current = site.current_deployment_id && deployer.getDeployment(site.current_deployment_id);
  if (!current) throw new HttpError(400, "Aucune version en ligne à reconstruire.");
  const zipDep = current.zip_name ? current : db.get(
    "SELECT * FROM deployments WHERE site_id = ? AND status = 'success' AND kind IN ('initial','update','rebuild') ORDER BY id DESC LIMIT 1",
    site.id
  );
  if (!zipDep) throw new HttpError(400, 'Aucune archive disponible pour reconstruire.');
  const deployment = deployer.enqueue({
    site,
    actor: req.user,
    kind: 'rebuild',
    source: req.authType === 'token' ? 'api' : 'web',
    fromDeployment: zipDep,
  });
  res.status(202).json({ deployment: deployer.serialize(deployment) });
});

for (const action of ['start', 'stop', 'restart']) {
  router.post(`/:ref/${action}`, async (req, res) => {
    const site = load(req);
    ensureNotBusy(site);
    const updated = await sites[action](site, req.user);
    res.json({ site: sites.serialize(updated) });
  });
}

router.get('/:ref/deployments', (req, res) => {
  const site = load(req);
  const list = deployer.listForSite(site.id, 50);
  const images = new Set(list.filter((d) => d.status === 'success' && d.image).map((d) => d.image));
  res.json({ deployments: list, rollback_images: [...images] });
});

router.get('/:ref/deployments/:id', (req, res) => {
  const site = load(req);
  const dep = deployer.getDeployment(Number(req.params.id));
  if (!dep || dep.site_id !== site.id) throw new HttpError(404, 'Déploiement introuvable.');
  res.json({ deployment: deployer.serialize(dep, { withLog: true }) });
});

router.get('/:ref/deployments/:id/stream', (req, res) => {
  const site = load(req);
  const dep = deployer.getDeployment(Number(req.params.id));
  if (!dep || dep.site_id !== site.id) throw new HttpError(404, 'Déploiement introuvable.');
  deployer.subscribe(dep.id, res);
});

router.post('/:ref/deployments/:id/rollback', async (req, res) => {
  const site = load(req);
  const dep = deployer.getDeployment(Number(req.params.id));
  if (!dep || dep.site_id !== site.id || dep.status !== 'success' || !dep.image) {
    throw new HttpError(400, 'Cette version ne peut pas être restaurée.');
  }
  if (!(await docker.imageExists(dep.image))) throw new HttpError(410, "L'image de cette version a été supprimée.");
  const deployment = deployer.enqueue({
    site,
    actor: req.user,
    kind: 'rollback',
    source: req.authType === 'token' ? 'api' : 'web',
    image: dep.image,
    fromDeployment: dep,
  });
  res.status(202).json({ deployment: deployer.serialize(deployment) });
});

router.get('/:ref/logs', async (req, res) => {
  const site = load(req);
  if (!site.container_id) return res.json({ logs: '' });
  const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 300, 10), 5000);
  try {
    res.json({ logs: await docker.containerLogs(site.container_id, tail) });
  } catch (err) {
    if (err.statusCode === 404) return res.json({ logs: '' });
    throw new HttpError(503, `Docker injoignable : ${err.message}`);
  }
});

router.get('/:ref/stats', (req, res) => {
  const site = load(req);
  res.json({
    summary: stats.summary(site.id),
    hourly: stats.hourly(site.id, 24),
    daily: stats.daily(site.id, 14),
    recent: stats.recentAccesses(site.id),
  });
});

router.get('/:ref/events', (req, res) => {
  const site = load(req);
  const rows = db.all('SELECT id, type, message, payload, created_at FROM events WHERE site_id = ? ORDER BY id DESC LIMIT 50', site.id);
  res.json({ events: rows.map((r) => ({ id: r.id, type: r.type, message: r.message, created_at: r.created_at })) });
});

module.exports = router;
