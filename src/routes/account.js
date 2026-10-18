const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { HttpError, sha256 } = require('../util');

const router = express.Router();
router.use(auth.requireAuth);

router.post('/password', (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verifyPassword(String(current || ''), user.password_hash)) {
    throw new HttpError(400, 'Mot de passe actuel incorrect.', 'BAD_PASSWORD');
  }
  auth.validatePassword(next);
  if (next === current) throw new HttpError(400, "Le nouveau mot de passe doit être différent de l'ancien.");
  db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', auth.hashPassword(next), user.id);
  // Sign out other sessions.
  if (req.sessionToken) db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, sha256(req.sessionToken));
  res.json({ ok: true });
});

router.get('/tokens', (req, res) => {
  const tokens = db.all(
    'SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC',
    req.user.id
  );
  res.json({ tokens });
});

router.post('/tokens', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Donnez un nom au jeton (ex. « CI GitLab »).');
  const count = db.get('SELECT COUNT(*) n FROM api_tokens WHERE user_id = ?', req.user.id).n;
  if (count >= 20) throw new HttpError(400, '20 jetons maximum par compte.');
  const { id, token } = auth.createApiToken(req.user.id, name);
  res.status(201).json({ id, name, token });
});

router.delete('/tokens/:id', (req, res) => {
  const r = db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!r.changes) throw new HttpError(404, 'Jeton introuvable.');
  res.json({ ok: true });
});

module.exports = router;
