const fs = require('fs');
const os = require('os');
const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const sites = require('../services/sites');
const deployer = require('../services/deployer');
const stats = require('../services/stats');
const docker = require('../services/docker');
const settings = require('../services/settings');
const notifier = require('../services/notifier');
const { HttpError, nowIso, generatePassword } = require('../util');

const router = express.Router();
router.use(auth.requireSuperadmin);

let cpuSample = null;
function cpuUsagePercent() {
  const cpus = os.cpus();
  const totals = cpus.reduce(
    (acc, c) => {
      const t = Object.values(c.times).reduce((a, b) => a + b, 0);
      acc.total += t;
      acc.idle += c.times.idle;
      return acc;
    },
    { total: 0, idle: 0 }
  );
  const prev = cpuSample;
  cpuSample = totals;
  if (!prev || totals.total === prev.total) return null;
  return Math.round((1 - (totals.idle - prev.idle) / (totals.total - prev.total)) * 1000) / 10;
}
cpuUsagePercent();

function diskUsage() {
  try {
    const s = fs.statfsSync(config.dataDir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

router.get('/overview', async (req, res) => {
  let engine = null;
  try {
    engine = await docker.engineInfo();
  } catch (err) {
    engine = { error: err.message };
  }
  const counts = {
    users: db.get("SELECT COUNT(*) n FROM users WHERE role = 'user'").n,
    sites: db.get('SELECT COUNT(*) n FROM sites').n,
    running: db.get("SELECT COUNT(*) n FROM sites WHERE status = 'running'").n,
    errors: db.get("SELECT COUNT(*) n FROM sites WHERE status = 'error'").n,
    deployments_24h: db.get('SELECT COUNT(*) n FROM deployments WHERE created_at >= ?', new Date(Date.now() - 86400000).toISOString()).n,
    failed_24h: db.get("SELECT COUNT(*) n FROM deployments WHERE status = 'failed' AND created_at >= ?", new Date(Date.now() - 86400000).toISOString()).n,
  };
  const top = db
    .all('SELECT * FROM sites ORDER BY total_requests DESC LIMIT 100')
    .map((s) => ({ ...sites.serialize(s), stats: stats.summary(s.id) }))
    .sort((a, b) => b.stats.requests_24h - a.stats.requests_24h);
  res.json({
    counts,
    host: {
      hostname: os.hostname(),
      public_host: settings.publicHost(),
      detected_ip: settings.detectHostIp(),
      platform: `${os.type()} ${os.release()}`,
      uptime: os.uptime(),
      load: os.loadavg(),
      cpus: os.cpus().length,
      cpu_percent: cpuUsagePercent(),
      memory: { total: os.totalmem(), free: os.freemem() },
      disk: diskUsage(),
      ezdocker_version: config.version,
      node: process.version,
      panel_port: config.port,
    },
    docker: engine,
    traffic: { summary: stats.summary(null), hourly: stats.hourly(null, 24) },
    sites: top,
  });
});

// --- Users -----------------------------------------------------------------

function limitsFrom(body, current = {}) {
  const out = {};
  if (body.max_sites !== undefined) {
    const v = Number(body.max_sites);
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw new HttpError(400, 'Nombre de sites invalide (0-1000).');
    out.max_sites = v;
  }
  if (body.max_memory_mb !== undefined) {
    const v = Number(body.max_memory_mb);
    if (!Number.isInteger(v) || v < 32 || v > 65536) throw new HttpError(400, 'Mémoire invalide (32-65536 Mo).');
    out.max_memory_mb = v;
  }
  if (body.max_cpus !== undefined) {
    const v = Number(body.max_cpus);
    if (!Number.isFinite(v) || v < 0.1 || v > 64) throw new HttpError(400, 'CPU invalide (0.1-64).');
    out.max_cpus = Math.round(v * 100) / 100;
  }
  return { ...current, ...out };
}

function userView(u) {
  const count = db.get('SELECT COUNT(*) n FROM sites WHERE owner_id = ?', u.id).n;
  return { ...auth.publicUser(u), sites_count: count };
}

router.get('/users', (req, res) => {
  res.json({ users: db.all('SELECT * FROM users ORDER BY role DESC, username COLLATE NOCASE').map(userView) });
});

router.post('/users', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, "Nom d'utilisateur : 3 à 32 caractères (lettres, chiffres, . _ -).");
  }
  if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'Ce nom est déjà pris.');
  const email = String(body.email || '').trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mail invalide.');

  const generated = !body.password;
  const password = body.password ? String(body.password) : generatePassword();
  auth.validatePassword(password);
  const limits = limitsFrom(body, {
    max_sites: Number(settings.get('default_max_sites')),
    max_memory_mb: Number(settings.get('default_memory_mb')),
    max_cpus: Number(settings.get('default_cpus')),
  });
  const id = db.run(
    `INSERT INTO users (username, email, password_hash, role, max_sites, max_memory_mb, max_cpus, must_change_password, created_at)
     VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
    username, email || null, auth.hashPassword(password), limits.max_sites, limits.max_memory_mb, limits.max_cpus,
    body.must_change_password === false ? 0 : 1, nowIso()
  ).lastInsertRowid;
  res.status(201).json({ user: userView(db.get('SELECT * FROM users WHERE id = ?', id)), password, generated });
});

function loadUser(id) {
  const u = db.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!u) throw new HttpError(404, 'Utilisateur introuvable.');
  return u;
}

router.patch('/users/:id', (req, res) => {
  const u = loadUser(req.params.id);
  const body = req.body || {};
  const fields = limitsFrom(body);
  if (body.email !== undefined) {
    const email = String(body.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mail invalide.');
    fields.email = email || null;
  }
  if (body.disabled !== undefined) {
    if (u.role === 'superadmin') throw new HttpError(400, 'Le super administrateur ne peut pas être désactivé.');
    fields.disabled = body.disabled ? 1 : 0;
  }
  const keys = Object.keys(fields);
  if (keys.length) db.run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), u.id);
  if (fields.disabled) db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  res.json({ user: userView(loadUser(u.id)) });
});

router.post('/users/:id/reset-password', (req, res) => {
  const u = loadUser(req.params.id);
  const password = req.body?.password ? String(req.body.password) : generatePassword();
  auth.validatePassword(password);
  db.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', auth.hashPassword(password), u.id === req.user.id ? 0 : 1, u.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  res.json({ password });
});

router.delete('/users/:id', async (req, res) => {
  const u = loadUser(req.params.id);
  if (u.role === 'superadmin') throw new HttpError(400, 'Le super administrateur ne peut pas être supprimé.');
  const owned = db.all('SELECT * FROM sites WHERE owner_id = ?', u.id);
  if (owned.some((s) => deployer.isBusy(s.id))) throw new HttpError(409, 'Un déploiement est en cours sur un de ses sites.');
  for (const site of owned) await sites.remove(site, req.user);
  db.run('DELETE FROM users WHERE id = ?', u.id);
  res.json({ ok: true, deleted_sites: owned.length });
});

// --- Settings --------------------------------------------------------------

const SECRET_MASK = '••••••••';

function publicSettings() {
  const s = settings.all();
  delete s.stats_salt;
  if (s.smtp_pass) s.smtp_pass = SECRET_MASK;
  return { ...s, all_events: settings.ALL_EVENTS, event_labels: notifier.LABELS };
}

function cleanSettings(body) {
  const out = {};
  const str = (k, max = 300) => {
    if (body[k] !== undefined) out[k] = String(body[k] ?? '').trim().slice(0, max);
  };
  const intIn = (k, min, max) => {
    if (body[k] === undefined) return;
    const v = Number(body[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `Valeur invalide pour ${k} (${min}-${max}).`);
    out[k] = v;
  };
  const bool = (k) => {
    if (body[k] !== undefined) out[k] = !!body[k];
  };
  const events = (k) => {
    if (body[k] === undefined) return;
    if (!Array.isArray(body[k])) throw new HttpError(400, `Liste d'événements invalide pour ${k}.`);
    out[k] = body[k].filter((e) => settings.ALL_EVENTS.includes(e));
  };

  str('instance_name', 60);
  str('public_host', 253);
  intIn('port_range_start', 1024, 65535);
  intIn('port_range_end', 1024, 65535);
  intIn('max_upload_mb', 1, 10240);
  intIn('default_max_sites', 0, 1000);
  intIn('default_memory_mb', 32, 65536);
  if (body.default_cpus !== undefined) {
    const v = Number(body.default_cpus);
    if (!Number.isFinite(v) || v < 0.1 || v > 64) throw new HttpError(400, 'CPU par défaut invalide.');
    out.default_cpus = v;
  }
  bool('webhook_enabled');
  str('webhook_url', 1000);
  str('webhook_secret', 200);
  events('webhook_events');
  bool('smtp_enabled');
  str('smtp_host', 253);
  intIn('smtp_port', 1, 65535);
  bool('smtp_secure');
  str('smtp_user', 200);
  if (body.smtp_pass !== undefined && body.smtp_pass !== SECRET_MASK) out.smtp_pass = String(body.smtp_pass);
  str('smtp_from', 200);
  str('smtp_to', 1000);
  events('smtp_events');

  if (out.instance_name === '') delete out.instance_name;
  if (out.webhook_url && !/^https?:\/\//i.test(out.webhook_url)) throw new HttpError(400, "L'URL du webhook doit commencer par http:// ou https://");
  if (out.public_host && !/^[a-zA-Z0-9.:[\]-]+$/.test(out.public_host)) throw new HttpError(400, 'Adresse publique invalide.');
  const start = out.port_range_start ?? settings.get('port_range_start');
  const end = out.port_range_end ?? settings.get('port_range_end');
  if (start > end) throw new HttpError(400, 'Plage de ports invalide.');
  if (end + config.internalPortOffset > 65535) {
    throw new HttpError(400, `La fin de plage doit être ≤ ${65535 - config.internalPortOffset}.`);
  }
  return out;
}

router.get('/settings', (req, res) => res.json({ settings: publicSettings() }));

router.put('/settings', async (req, res) => {
  const values = cleanSettings(req.body || {});
  const hostChanged = values.public_host !== undefined && values.public_host !== settings.get('public_host');
  settings.set(values);
  if (hostChanged || values.instance_name) for (const s of db.all('SELECT * FROM sites')) await sites.syncProxy(s);
  res.json({ settings: publicSettings() });
});

router.post('/settings/test-webhook', async (req, res) => {
  const override = cleanSettings(req.body || {});
  try {
    const r = await notifier.testWebhook(req.user, override);
    res.json({ ok: r.ok, status: r.status, ms: r.ms });
  } catch (err) {
    res.json({ ok: false, error: err.cause?.code || err.message });
  }
});

router.post('/settings/test-email', async (req, res) => {
  const override = cleanSettings(req.body || {});
  try {
    await notifier.testEmail(req.user, req.body?.to, override);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get('/deliveries', (req, res) => {
  const rows = db.all(
    `SELECT d.*, e.type FROM deliveries d LEFT JOIN events e ON e.id = d.event_id ORDER BY d.id DESC LIMIT 100`
  );
  res.json({ deliveries: rows });
});

module.exports = router;
