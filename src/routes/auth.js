const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const settings = require('../services/settings');
const { HttpError, nowIso, asyncRoute } = require('../util');

const router = express.Router();

router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    auth.checkLoginRate(req.ip);
    auth.checkLoginRate(key);

    const user = username ? db.get('SELECT * FROM users WHERE username = ?', username) : null;
    // Always run scrypt to keep timing constant whether the user exists or not.
    const ok = auth.verifyPassword(password, user ? user.password_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!user || !ok) {
      auth.recordLoginFailure(req.ip);
      auth.recordLoginFailure(key);
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect.', 'BAD_CREDENTIALS');
    }
    if (user.disabled) throw new HttpError(403, 'Ce compte est désactivé.', 'DISABLED');

    auth.clearLoginFailures(key);
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
    const token = auth.createSession(user.id, req);
    auth.setSessionCookie(res, token);
    res.json({ user: auth.publicUser(user) });
  })
);

router.post('/logout', (req, res) => {
  if (req.sessionToken) auth.destroySession(req.sessionToken);
  res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const instance = { name: settings.get('instance_name'), version: config.version, host: settings.publicHost() };
  res.json({ user: req.user ? auth.publicUser(req.user) : null, instance });
});

module.exports = router;
