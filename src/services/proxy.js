const http = require('http');
const net = require('net');
const config = require('../config');
const { log } = require('../util');

// siteId -> { server, port, internalPort, mode, name }
const proxies = new Map();
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

let recorder = () => {};

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

function clientIp(req) {
  const ip = req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function filterRawHeaders(raw, dropTransferEncoding) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (dropTransferEncoding && key === 'transfer-encoding') continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

function forwardedHeaders(req, ip, entry) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  const prior = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = prior ? `${prior}, ${ip}` : ip;
  headers['x-real-ip'] = ip;
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'http';
  headers['x-forwarded-port'] = String(entry.port);
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  return headers;
}

const PAGES = {
  pending: {
    status: 503,
    title: 'En attente du premier déploiement',
    text: "Ce site n'a pas encore été déployé. Déposez une archive .zip depuis EZDocker.",
    refresh: 10,
  },
  deploying: {
    status: 503,
    title: 'Déploiement en cours…',
    text: 'Le site est en cours de construction. Cette page se recharge automatiquement.',
    refresh: 4,
  },
  stopped: { status: 503, title: 'Site arrêté', text: 'Ce site a été mis en pause par son propriétaire.', refresh: 0 },
  down: {
    status: 502,
    title: 'Le site ne répond pas',
    text: "L'application ne répond pas pour le moment (démarrage ou redémarrage en cours ?). Nouvel essai automatique.",
    refresh: 5,
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderPage(kind, siteName) {
  const p = PAGES[kind];
  const refresh = p.refresh ? `<meta http-equiv="refresh" content="${p.refresh}">` : '';
  const spinner = kind === 'deploying' || kind === 'down' ? '<div class="spin"></div>' : '<div class="dot"></div>';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>${escapeHtml(p.title)}</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background:radial-gradient(circle at 20% 20%,#312e81 0,transparent 45%),radial-gradient(circle at 80% 80%,#0e7490 0,transparent 40%),#0b0f1a;color:#e5e7eb}
.card{max-width:440px;margin:24px;padding:40px 32px;border-radius:20px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
backdrop-filter:blur(12px);text-align:center;animation:in .6s ease-out}h1{font-size:1.35rem;margin:20px 0 8px}p{color:#9ca3af;line-height:1.5;margin:0}
small{display:block;margin-top:24px;color:#6b7280}.spin{width:44px;height:44px;margin:auto;border-radius:50%;border:4px solid rgba(255,255,255,.15);
border-top-color:#818cf8;animation:r 1s linear infinite}.dot{width:16px;height:16px;margin:14px auto;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 0 #f59e0b80;
animation:p 2s infinite}@keyframes r{to{transform:rotate(360deg)}}@keyframes p{70%{box-shadow:0 0 0 18px #f59e0b00}}@keyframes in{from{opacity:0;transform:translateY(12px)}}
</style></head><body><div class="card">${spinner}<h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.text)}</p>
<small>${escapeHtml(siteName || '')} · propulsé par EZDocker</small></div></body></html>`;
}

function sendPage(res, kind, entry) {
  const body = renderPage(kind, entry.name);
  res.writeHead(PAGES[kind].status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'retry-after': '5',
  });
  res.end(body);
  return Buffer.byteLength(body);
}

function handleRequest(siteId, req, res) {
  const entry = proxies.get(siteId);
  const started = process.hrtime.bigint();
  const ip = clientIp(req);
  let bytesIn = 0;
  let bytesOut = 0;
  let recorded = false;

  const record = () => {
    if (recorded) return;
    recorded = true;
    recorder(siteId, {
      ip,
      method: req.method,
      path: req.url,
      status: res.statusCode,
      bytesIn,
      bytesOut,
      ms: Number(process.hrtime.bigint() - started) / 1e6,
      userAgent: req.headers['user-agent'] || '',
    });
  };
  res.on('close', record);

  if (entry.mode !== 'proxy') {
    req.resume();
    bytesOut = sendPage(res, entry.mode, entry);
    return;
  }

  const upstream = http.request(
    {
      host: config.upstreamHost,
      port: entry.internalPort,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, ip, entry),
      agent,
    },
    (pres) => {
      pres.on('data', (chunk) => {
        bytesOut += chunk.length;
      });
      res.writeHead(pres.statusCode, pres.statusMessage, filterRawHeaders(pres.rawHeaders, req.httpVersion === '1.0'));
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    }
  );

  upstream.on('error', () => {
    if (!res.headersSent) bytesOut = sendPage(res, 'down', entry);
    else res.destroy();
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.on('data', (chunk) => {
    bytesIn += chunk.length;
  });
  req.pipe(upstream);
}

function handleUpgrade(siteId, req, socket, head) {
  const entry = proxies.get(siteId);
  const ip = clientIp(req);
  socket.on('error', () => {});
  if (entry.mode !== 'proxy') return socket.destroy();

  const upstream = net.connect(entry.internalPort, config.upstreamHost, () => {
    const headers = forwardedHeaders(req, ip, entry);
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const value of Array.isArray(v) ? v : [v]) raw += `${k}: ${value}\r\n`;
    }
    raw += `connection: Upgrade\r\nupgrade: ${req.headers.upgrade}\r\n\r\n`;
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    recorder(siteId, { ip, method: req.method, path: req.url, status: 101, bytesIn: 0, bytesOut: 0, ms: 0, userAgent: req.headers['user-agent'] || '' });
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

/** Creates or updates the public listener for a site. */
function ensure({ id, name, public_port, internal_port, mode }) {
  const existing = proxies.get(id);
  if (existing && existing.port === public_port) {
    Object.assign(existing, { name, internalPort: internal_port, mode });
    return Promise.resolve(existing);
  }
  if (existing) close(id);

  const entry = { port: public_port, internalPort: internal_port, mode, name, server: null, listening: false };
  const server = http.createServer((req, res) => handleRequest(id, req, res));
  server.on('upgrade', (req, socket, head) => handleUpgrade(id, req, socket, head));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0;
  entry.server = server;
  proxies.set(id, entry);

  return new Promise((resolve) => {
    server.once('error', (err) => {
      log.error(`Proxy du site #${id} : impossible d'écouter sur le port ${public_port} (${err.code || err.message})`);
      entry.error = err.code || err.message;
      resolve(entry);
    });
    server.listen(public_port, config.host, () => {
      entry.listening = true;
      resolve(entry);
    });
  });
}

function setMode(id, mode) {
  const entry = proxies.get(id);
  if (entry) entry.mode = mode;
}

function close(id) {
  const entry = proxies.get(id);
  if (!entry) return;
  proxies.delete(id);
  entry.server.close();
  entry.server.closeAllConnections?.();
}

function closeAll() {
  for (const id of [...proxies.keys()]) close(id);
}

function status(id) {
  const entry = proxies.get(id);
  if (!entry) return { listening: false, error: 'absent' };
  return { listening: entry.listening, error: entry.error || null, mode: entry.mode };
}

function setRecorder(fn) {
  recorder = fn;
}

module.exports = { ensure, setMode, close, closeAll, status, setRecorder, renderPage };
