const fs = require('fs');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const settings = require('./services/settings');
const docker = require('./services/docker');
const proxy = require('./services/proxy');
const stats = require('./services/stats');
const sites = require('./services/sites');
const deployer = require('./services/deployer');
const monitor = require('./services/monitor');
const notifier = require('./services/notifier');
const { HttpError, nowIso, generatePassword, log } = require('./util');

function prepareDataDir() {
  for (const dir of [config.dataDir, path.join(config.dataDir, 'tmp'), path.join(config.dataDir, 'sites')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Leftover partial uploads from a previous run.
  for (const f of fs.readdirSync(path.join(config.dataDir, 'tmp'))) {
    fs.rmSync(path.join(config.dataDir, 'tmp', f), { recursive: true, force: true });
  }
}

function bootstrapSuperadmin() {
  if (db.get("SELECT 1 FROM users WHERE role = 'superadmin'")) return;
  const generated = !config.adminPassword;
  const password = config.adminPassword || generatePassword(16);
  db.run(
    `INSERT INTO users (username, email, password_hash, role, max_sites, max_memory_mb, max_cpus, must_change_password, created_at)
     VALUES (?, ?, ?, 'superadmin', 1000, 65536, 64, ?, ?)`,
    config.adminUser, config.adminEmail || null, auth.hashPassword(password), generated ? 1 : 0, nowIso()
  );
  log.info(`Compte super admin créé : ${config.adminUser}`);
  if (generated) {
    log.info('==============================================');
    log.info(`  Mot de passe initial : ${password}`);
    log.info('  (à changer à la première connexion)');
    log.info('==============================================');
  }
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  app.get('/api/health', async (req, res) => {
    res.json({ ok: true, version: config.version, docker: await docker.ping() });
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(auth.authenticate);

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/account', require('./routes/account'));
  app.use('/api/sites', require('./routes/sites'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/admin', require('./routes/admin'));

  app.get('/api/example.zip', auth.requireAuth, (req, res) => {
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(config.examplesDir, 'hello-site'));
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', 'attachment; filename="ezdocker-exemple.zip"');
    res.end(zip.toBuffer());
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Route inconnue.', 'NOT_FOUND')));

  app.use(
    express.static(config.publicDir, {
      index: false,
      // Revalidate every time (ETag): no stale UI after an update.
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    })
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Erreur interne.';
    if (err.type === 'entity.parse.failed') message = 'JSON invalide.';
    if (err.type === 'entity.too.large') message = 'Requête trop volumineuse.';
    if (!(err instanceof HttpError) && status >= 500) {
      log.error(`${req.method} ${req.originalUrl}`, err);
      if (err.statusCode && err.json) message = `Docker : ${err.json.message || err.message}`;
      else if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') message = 'Docker est injoignable.';
      status = status < 500 ? status : 500;
    }
    if (res.headersSent) return res.end();
    res.status(status).json({ error: message, code: err.code && typeof err.code === 'string' ? err.code : undefined });
  });

  return app;
}

async function main() {
  prepareDataDir();
  db.open(config.dbFile);
  settings.init();
  bootstrapSuperadmin();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    log.info(`EZDocker ${config.version} — panel sur http://${settings.publicHost()}:${config.port}`);
  });
  server.on('error', (err) => {
    log.error(`Impossible d'écouter sur le port ${config.port} : ${err.message}`);
    process.exit(1);
  });

  proxy.setRecorder(stats.record);
  stats.start();
  deployer.recoverInterrupted();
  await sites.bootstrap();

  if (await docker.ping()) {
    try {
      await docker.ensureNetwork();
      await monitor.reconcile();
    } catch (err) {
      log.warn('Initialisation Docker partielle :', err.message);
    }
  } else {
    log.warn(`Docker injoignable (${config.dockerSocket}). Les déploiements échoueront tant qu'il n'est pas disponible.`);
  }
  monitor.start({ updateSite: sites.update });

  const housekeeping = () => {
    try {
      stats.cleanup();
      notifier.cleanup();
    } catch (err) {
      log.warn('Nettoyage :', err.message);
    }
  };
  housekeeping();
  setInterval(housekeeping, 6 * 3600 * 1000).unref();

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} reçu, arrêt…`);
    monitor.stop();
    stats.stop();
    proxy.closeAll();
    server.close();
    server.closeAllConnections?.();
    db.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    log.error('Démarrage impossible', err);
    process.exit(1);
  });
}

module.exports = { createApp, main };
