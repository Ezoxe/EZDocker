const db = require('../db');
const settings = require('./settings');
const { sha256, nowIso } = require('../util');

const RECENT_MAX = 60;

// `${siteId}|${hour}` -> aggregate not yet written to SQLite
let pending = new Map();
let pendingVisitors = new Map(); // `${siteId}|${day}|${hash}` -> [siteId, day, hash]
const recent = new Map(); // siteId -> [{...}] newest first
const lastAccess = new Map(); // siteId -> iso

const hourKey = (d = new Date()) => d.toISOString().slice(0, 13);
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function record(siteId, { ip, method, path, status, bytesIn, bytesOut, ms, userAgent }) {
  const now = new Date();
  const hour = hourKey(now);
  const key = `${siteId}|${hour}`;
  let agg = pending.get(key);
  if (!agg) {
    agg = { siteId, hour, requests: 0, bytesIn: 0, bytesOut: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, totalMs: 0 };
    pending.set(key, agg);
  }
  agg.requests++;
  agg.bytesIn += bytesIn || 0;
  agg.bytesOut += bytesOut || 0;
  agg.totalMs += Math.round(ms || 0);
  if (status >= 500) agg.s5xx++;
  else if (status >= 400) agg.s4xx++;
  else if (status >= 300) agg.s3xx++;
  else agg.s2xx++;

  const day = dayKey(now);
  const hash = sha256(settings.get('stats_salt') + ip).slice(0, 16);
  pendingVisitors.set(`${siteId}|${day}|${hash}`, [siteId, day, hash]);

  const iso = now.toISOString();
  lastAccess.set(siteId, iso);
  let list = recent.get(siteId);
  if (!list) recent.set(siteId, (list = []));
  list.unshift({
    at: iso,
    ip,
    method,
    path: String(path || '').slice(0, 200),
    status,
    ms: Math.round(ms || 0),
    bytes: bytesOut || 0,
    ua: String(userAgent || '').slice(0, 160),
  });
  if (list.length > RECENT_MAX) list.length = RECENT_MAX;
}

function flush() {
  if (pending.size === 0 && pendingVisitors.size === 0) return;
  const aggs = pending;
  const visitors = pendingVisitors;
  const access = new Map(lastAccess);
  pending = new Map();
  pendingVisitors = new Map();

  const perSite = new Map();
  db.tx(() => {
    for (const a of aggs.values()) {
      db.run(
        `INSERT INTO stats_hourly (site_id, hour, requests, bytes_in, bytes_out, s2xx, s3xx, s4xx, s5xx, total_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, hour) DO UPDATE SET
           requests = requests + excluded.requests, bytes_in = bytes_in + excluded.bytes_in,
           bytes_out = bytes_out + excluded.bytes_out, s2xx = s2xx + excluded.s2xx, s3xx = s3xx + excluded.s3xx,
           s4xx = s4xx + excluded.s4xx, s5xx = s5xx + excluded.s5xx, total_ms = total_ms + excluded.total_ms`,
        a.siteId, a.hour, a.requests, a.bytesIn, a.bytesOut, a.s2xx, a.s3xx, a.s4xx, a.s5xx, a.totalMs
      );
      const s = perSite.get(a.siteId) || { requests: 0, bytesOut: 0 };
      s.requests += a.requests;
      s.bytesOut += a.bytesOut;
      perSite.set(a.siteId, s);
    }
    for (const [siteId, day, hash] of visitors.values()) {
      db.run('INSERT OR IGNORE INTO visitors_daily (site_id, day, ip_hash) VALUES (?, ?, ?)', siteId, day, hash);
    }
    for (const [siteId, s] of perSite) {
      db.run(
        'UPDATE sites SET total_requests = total_requests + ?, total_bytes_out = total_bytes_out + ?, last_access_at = ? WHERE id = ?',
        s.requests, s.bytesOut, access.get(siteId) || nowIso(), siteId
      );
    }
  });
}

function hoursBack(n) {
  const out = [];
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  for (let i = n - 1; i >= 0; i--) out.push(hourKey(new Date(d.getTime() - i * 3600000)));
  return out;
}

function daysBack(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(d.getTime() - i * 86400000)));
  return out;
}

function emptyRow() {
  return { requests: 0, bytes_in: 0, bytes_out: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, total_ms: 0 };
}

function sumRows(rows) {
  const t = emptyRow();
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] || 0;
  return t;
}

/** Hourly series for the last 24h. siteId = null for all sites. */
function hourly(siteId, hours = 24) {
  flush();
  const keys = hoursBack(hours);
  const where = siteId == null ? '' : 'AND site_id = ?';
  const params = siteId == null ? [keys[0]] : [keys[0], siteId];
  const rows = db.all(
    `SELECT hour, SUM(requests) requests, SUM(bytes_in) bytes_in, SUM(bytes_out) bytes_out, SUM(s2xx) s2xx, SUM(s3xx) s3xx,
            SUM(s4xx) s4xx, SUM(s5xx) s5xx, SUM(total_ms) total_ms
     FROM stats_hourly WHERE hour >= ? ${where} GROUP BY hour`,
    ...params
  );
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  return keys.map((h) => ({ ...emptyRow(), ...(byHour.get(h) || {}), hour: `${h}:00:00.000Z` }));
}

function daily(siteId, days = 14) {
  flush();
  const keys = daysBack(days);
  const where = siteId == null ? '' : 'AND site_id = ?';
  const params = siteId == null ? [keys[0]] : [keys[0], siteId];
  const rows = db.all(
    `SELECT substr(hour, 1, 10) day, SUM(requests) requests, SUM(bytes_out) bytes_out, SUM(s5xx) s5xx
     FROM stats_hourly WHERE hour >= ? ${where} GROUP BY day`,
    ...params
  );
  const visitorRows = db.all(
    `SELECT day, COUNT(*) visitors FROM visitors_daily WHERE day >= ? ${where} GROUP BY day`,
    ...params
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const vByDay = new Map(visitorRows.map((r) => [r.day, r.visitors]));
  return keys.map((d) => ({
    day: d,
    requests: byDay.get(d)?.requests || 0,
    bytes_out: byDay.get(d)?.bytes_out || 0,
    errors: byDay.get(d)?.s5xx || 0,
    visitors: vByDay.get(d) || 0,
  }));
}

function summary(siteId) {
  const series = hourly(siteId, 24);
  const t = sumRows(series);
  const where = siteId == null ? '' : 'AND site_id = ?';
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const params = siteId == null ? [yesterday] : [yesterday, siteId];
  const visitors24h = db.get(
    `SELECT COUNT(DISTINCT ip_hash) n FROM visitors_daily WHERE day >= ? ${where}`,
    ...params
  ).n;
  const visitorsToday = db.get(
    `SELECT COUNT(*) n FROM visitors_daily WHERE day = ? ${where}`,
    ...(siteId == null ? [today] : [today, siteId])
  ).n;
  const totals = siteId == null
    ? db.get('SELECT COALESCE(SUM(total_requests),0) requests, COALESCE(SUM(total_bytes_out),0) bytes_out, MAX(last_access_at) last FROM sites')
    : db.get('SELECT total_requests requests, total_bytes_out bytes_out, last_access_at last FROM sites WHERE id = ?', siteId) || {};
  return {
    requests_24h: t.requests,
    bytes_in_24h: t.bytes_in,
    bytes_out_24h: t.bytes_out,
    errors_24h: t.s5xx,
    client_errors_24h: t.s4xx,
    status_24h: { '2xx': t.s2xx, '3xx': t.s3xx, '4xx': t.s4xx, '5xx': t.s5xx },
    avg_ms_24h: t.requests ? Math.round(t.total_ms / t.requests) : 0,
    visitors_24h: visitors24h,
    visitors_today: visitorsToday,
    requests_total: totals.requests || 0,
    bytes_out_total: totals.bytes_out || 0,
    last_access_at: totals.last || null,
    sparkline: series.map((r) => r.requests),
  };
}

function recentAccesses(siteId) {
  return recent.get(siteId) || [];
}

function forget(siteId) {
  recent.delete(siteId);
  lastAccess.delete(siteId);
  for (const k of [...pending.keys()]) if (k.startsWith(`${siteId}|`)) pending.delete(k);
  for (const k of [...pendingVisitors.keys()]) if (k.startsWith(`${siteId}|`)) pendingVisitors.delete(k);
  db.run('DELETE FROM stats_hourly WHERE site_id = ?', siteId);
  db.run('DELETE FROM visitors_daily WHERE site_id = ?', siteId);
}

function cleanup() {
  db.run('DELETE FROM stats_hourly WHERE hour < ?', hourKey(new Date(Date.now() - 90 * 86400000)));
  db.run('DELETE FROM visitors_daily WHERE day < ?', dayKey(new Date(Date.now() - 35 * 86400000)));
}

let timer = null;
function start() {
  timer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      console.error('stats flush failed', err);
    }
  }, 10000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  flush();
}

module.exports = { record, flush, hourly, daily, summary, recentAccesses, forget, cleanup, start, stop };
