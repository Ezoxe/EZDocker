const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { HttpError, nowIso, randomToken, sha256 } = require('./util');

const SESSION_COOKIE = 'ezd_session';
const CSRF_HEADER = 'x-ezdocker';
const TOKEN_PREFIX = 'ezd_';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.');
  }
  if (password.length > 200) throw new HttpError(400, 'Mot de passe trop long.');
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email || '',
    role: u.role,
    max_sites: u.max_sites,
    max_memory_mb: u.max_memory_mb,
    max_cpus: u.max_cpus,
    must_change_password: !!u.must_change_password,
    disabled: !!u.disabled,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

// --- Sessions -------------------------------------------------------------

function createSession(userId, req) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  db.run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), userId, nowIso(), expires, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200)
  );
  return token;
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: config.sessionDays * 86400000,
    path: '/',
  });
}

function destroySession(token) {
  if (token) db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

// --- API tokens -----------------------------------------------------------

function createApiToken(userId, name) {
  const token = TOKEN_PREFIX + randomToken(30);
  const r = db.run(
    'INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, name, sha256(token), token.slice(0, 10), nowIso()
  );
  return { id: r.lastInsertRowid, token };
}

// --- Middleware -----------------------------------------------------------

const lastTokenTouch = new Map();

function authenticate(req, res, next) {
  req.user = null;
  req.authType = null;

  const authz = req.headers.authorization || '';
  if (authz.startsWith('Bearer ')) {
    const token = authz.slice(7).trim();
    const row = db.get(
      `SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      sha256(token)
    );
    if (!row || row.disabled) return next(new HttpError(401, 'Jeton API invalide.', 'INVALID_TOKEN'));
    req.user = row;
    req.authType = 'token';
    const last = lastTokenTouch.get(row.token_id) || 0;
    if (Date.now() - last > 60000) {
      lastTokenTouch.set(row.token_id, Date.now());
      db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), row.token_id);
    }
    return next();
  }

  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const row = db.get(
      `SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      sha256(token)
    );
    if (row && !row.disabled && row.session_expires > nowIso()) {
      req.user = row;
      req.authType = 'session';
      req.sessionToken = token;
    } else if (row) {
      destroySession(token);
    }
  }
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/logout', '/api/account/password']);

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Authentification requise.', 'UNAUTHENTICATED'));
  if (req.authType === 'session') {
    // Custom header cannot be sent cross-site without a CORS preflight: cheap CSRF protection.
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
      return next(new HttpError(403, 'En-tête de sécurité manquant.', 'CSRF'));
    }
    if (req.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.has(req.originalUrl.split('?')[0])) {
      return next(new HttpError(403, 'Vous devez changer votre mot de passe.', 'PASSWORD_CHANGE_REQUIRED'));
    }
  }
  next();
}

function requireSuperadmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'superadmin') return next(new HttpError(403, 'Réservé au super administrateur.', 'FORBIDDEN'));
    next();
  });
}

// --- Login rate limiting --------------------------------------------------

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function checkLoginRate(key) {
  const entry = attempts.get(key);
  if (entry && entry.reset > Date.now() && entry.count >= MAX_ATTEMPTS) {
    const minutes = Math.ceil((entry.reset - Date.now()) / 60000);
    throw new HttpError(429, `Trop de tentatives. Réessayez dans ${minutes} min.`, 'RATE_LIMITED');
  }
}

function recordLoginFailure(key) {
  const entry = attempts.get(key);
  if (!entry || entry.reset < Date.now()) attempts.set(key, { count: 1, reset: Date.now() + WINDOW_MS });
  else entry.count++;
}

function clearLoginFailures(key) {
  attempts.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}, 10 * 60 * 1000).unref();

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  validatePassword,
  publicUser,
  createSession,
  setSessionCookie,
  destroySession,
  createApiToken,
  authenticate,
  requireAuth,
  requireSuperadmin,
  checkLoginRate,
  recordLoginFailure,
  clearLoginFailures,
};
