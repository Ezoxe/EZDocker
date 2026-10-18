const express = require('express');
const db = require('../db');
const auth = require('../auth');
const notifier = require('../services/notifier');

const router = express.Router();
router.use(auth.requireAuth);

/**
 * Event log, for the panel and for internal systems polling the API:
 *   GET /api/events?since=<last id>&type=site.updated&limit=100
 * Super admin sees everything, users only events of their sites.
 */
router.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const where = [];
  const params = [];
  if (req.user.role !== 'superadmin') {
    where.push('owner_id = ?');
    params.push(req.user.id);
  }
  if (req.query.since) {
    where.push('id > ?');
    params.push(Number(req.query.since) || 0);
  }
  if (req.query.before) {
    where.push('id < ?');
    params.push(Number(req.query.before) || 0);
  }
  if (req.query.type) {
    where.push('type = ?');
    params.push(String(req.query.type));
  }
  if (req.query.site_id) {
    where.push('site_id = ?');
    params.push(Number(req.query.site_id));
  }
  const order = req.query.since ? 'ASC' : 'DESC';
  const rows = db.all(
    `SELECT id, payload FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ${order} LIMIT ?`,
    ...params,
    limit
  );
  res.json({ events: rows.map((r) => JSON.parse(r.payload)), last_id: rows.length ? Math.max(...rows.map((r) => r.id)) : null });
});

/** Server-sent events for live panel refresh. */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const isAdmin = req.user.role === 'superadmin';
  const userId = req.user.id;
  const visible = (ownerId) => isAdmin || ownerId === userId;

  const onEvent = (evt) => {
    if (visible(evt.owner_id)) res.write(`event: activity\ndata: ${JSON.stringify(evt.payload)}\n\n`);
  };
  const onSite = (s) => {
    if (visible(s.owner_id)) res.write(`event: site\ndata: ${JSON.stringify(s)}\n\n`);
  };
  notifier.bus.on('event', onEvent);
  notifier.bus.on('site', onSite);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  res.on('close', () => {
    clearInterval(ping);
    notifier.bus.off('event', onEvent);
    notifier.bus.off('site', onSite);
  });
});

module.exports = router;
