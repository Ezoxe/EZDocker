const crypto = require('crypto');
const { EventEmitter } = require('events');
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');
const settings = require('./settings');
const { nowIso, log, sleep } = require('../util');

const LABELS = {
  'site.created': 'Site créé',
  'deployment.started': 'Déploiement démarré',
  'site.deployed': 'Site mis en ligne',
  'site.updated': 'Site mis à jour',
  'site.deploy_failed': 'Échec du déploiement',
  'site.crashed': 'Site planté',
  'site.started': 'Site démarré',
  'site.stopped': 'Site arrêté',
  'site.deleted': 'Site supprimé',
  test: 'Test',
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

const RETRY_DELAYS = [0, 5000, 30000];

function siteInfo(site) {
  if (!site) return null;
  const owner = db.get('SELECT username FROM users WHERE id = ?', site.owner_id);
  const host = settings.publicHost();
  return {
    id: site.id,
    name: site.name,
    slug: site.slug,
    owner: owner ? owner.username : null,
    owner_id: site.owner_id,
    status: site.status,
    host,
    port: site.public_port,
    url: `http://${host}:${site.public_port}`,
    container_id: site.container_id || null,
    image: site.image || null,
  };
}

function deploymentInfo(dep) {
  if (!dep) return null;
  return {
    id: dep.id,
    kind: dep.kind,
    source: dep.source,
    status: dep.status,
    error: dep.error || null,
    zip_name: dep.zip_name || null,
    duration_ms: dep.duration_ms ?? null,
    started_at: dep.started_at || null,
    finished_at: dep.finished_at || null,
  };
}

/** Records an event, pushes it to live listeners and dispatches webhook / e-mail. */
function emit(type, { site = null, deployment = null, actor = null, message = '', data = undefined } = {}) {
  const createdAt = nowIso();
  const payload = {
    id: null,
    event: type,
    label: LABELS[type] || type,
    message,
    timestamp: createdAt,
    instance: { name: settings.get('instance_name'), host: settings.publicHost(), version: config.version },
    actor: actor ? { id: actor.id, username: actor.username } : null,
    site: siteInfo(site),
    deployment: deploymentInfo(deployment),
  };
  if (data !== undefined) payload.data = data;

  let id = null;
  try {
    id = db.run(
      'INSERT INTO events (type, site_id, owner_id, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      type, site ? site.id : null, site ? site.owner_id : null, message, '{}', createdAt
    ).lastInsertRowid;
    payload.id = `evt_${id}`;
    db.run('UPDATE events SET payload = ? WHERE id = ?', JSON.stringify(payload), id);
  } catch (err) {
    log.error('Impossible d’enregistrer l’événement', type, err.message);
  }

  bus.emit('event', { id, type, site_id: site ? site.id : null, owner_id: site ? site.owner_id : null, payload });
  setImmediate(() => dispatch(id, payload).catch((err) => log.error('dispatch', err.message)));
  return payload;
}

async function dispatch(eventId, payload) {
  const s = settings.all();
  const jobs = [];
  if (s.webhook_enabled && s.webhook_url && (s.webhook_events || []).includes(payload.event)) {
    jobs.push(deliverWebhook(eventId, payload, s));
  }
  if (s.smtp_enabled && s.smtp_host && s.smtp_to && (s.smtp_events || []).includes(payload.event)) {
    jobs.push(deliverEmail(eventId, payload, s));
  }
  await Promise.allSettled(jobs);
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret || '').update(body).digest('hex');
}

async function postWebhook(url, secret, payload) {
  const body = JSON.stringify(payload);
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `EZDocker-Webhook/${config.version}`,
      'x-ezdocker-event': payload.event,
      'x-ezdocker-delivery': payload.id || crypto.randomUUID(),
      'x-ezdocker-timestamp': payload.timestamp,
      'x-ezdocker-signature': sign(secret, body),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  await res.arrayBuffer().catch(() => {});
  return { status: res.status, ok: res.status >= 200 && res.status < 300, ms: Date.now() - started };
}

async function deliverWebhook(eventId, payload, s) {
  let lastError = null;
  let lastStatus = null;
  const started = Date.now();
  for (let attempt = 1; attempt <= RETRY_DELAYS.length; attempt++) {
    if (RETRY_DELAYS[attempt - 1]) await sleep(RETRY_DELAYS[attempt - 1]);
    try {
      const r = await postWebhook(s.webhook_url, s.webhook_secret, payload);
      lastStatus = r.status;
      if (r.ok) {
        recordDelivery(eventId, 'webhook', s.webhook_url, true, r.status, attempt, null, Date.now() - started);
        return;
      }
      lastError = `HTTP ${r.status}`;
    } catch (err) {
      lastError = err.cause?.code || err.message;
    }
  }
  recordDelivery(eventId, 'webhook', s.webhook_url, false, lastStatus, RETRY_DELAYS.length, lastError, Date.now() - started);
  log.warn(`Webhook en échec pour ${payload.event} : ${lastError}`);
}

let transportKey = '';
let transport = null;

function getTransport(s) {
  const key = [s.smtp_host, s.smtp_port, s.smtp_secure, s.smtp_user, s.smtp_pass].join('|');
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({
      host: s.smtp_host,
      port: Number(s.smtp_port) || 587,
      secure: !!s.smtp_secure,
      auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
    transportKey = key;
  }
  return transport;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderEmail(payload) {
  const color = /failed|crashed/.test(payload.event) ? '#ef4444' : /deployed|updated|started/.test(payload.event) ? '#22c55e' : '#6366f1';
  const rows = [];
  if (payload.site) {
    rows.push(['Site', `${payload.site.name} (${payload.site.slug})`]);
    rows.push(['Propriétaire', payload.site.owner]);
    rows.push(['Adresse', payload.site.url]);
    rows.push(['Statut', payload.site.status]);
  }
  if (payload.deployment) {
    rows.push(['Déploiement', `#${payload.deployment.id} (${payload.deployment.kind})`]);
    if (payload.deployment.duration_ms != null) rows.push(['Durée', `${Math.round(payload.deployment.duration_ms / 1000)} s`]);
    if (payload.deployment.error) rows.push(['Erreur', payload.deployment.error]);
  }
  rows.push(['Date', payload.timestamp]);
  const text = [`${payload.label} — ${payload.message}`, '', ...rows.map(([k, v]) => `${k} : ${v}`)].join('\n');
  const html = `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
<div style="background:${color};color:#fff;padding:16px 20px;font-size:18px;font-weight:600">${escapeHtml(payload.label)}</div>
<div style="padding:20px"><p style="margin:0 0 16px;color:#111827">${escapeHtml(payload.message)}</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#6b7280;width:140px">${escapeHtml(k)}</td><td style="padding:6px 0;color:#111827">${escapeHtml(v)}</td></tr>`)
    .join('')}</table></div>
<div style="padding:12px 20px;background:#f9fafb;color:#9ca3af;font-size:12px">${escapeHtml(payload.instance.name)} · EZDocker ${escapeHtml(payload.instance.version)} · ${escapeHtml(payload.id || '')}</div></div>`;
  const subject = `[${payload.instance.name}] ${payload.label}${payload.site ? ' — ' + payload.site.name : ''}`;
  return { subject, text, html };
}

async function sendMail(s, to, payload) {
  const { subject, text, html } = renderEmail(payload);
  await getTransport(s).sendMail({ from: s.smtp_from || s.smtp_user, to, subject, text, html });
}

async function deliverEmail(eventId, payload, s) {
  const started = Date.now();
  try {
    await sendMail(s, s.smtp_to, payload);
    recordDelivery(eventId, 'email', s.smtp_to, true, null, 1, null, Date.now() - started);
  } catch (err) {
    recordDelivery(eventId, 'email', s.smtp_to, false, null, 1, err.message, Date.now() - started);
    log.warn(`E-mail en échec pour ${payload.event} : ${err.message}`);
  }
}

function recordDelivery(eventId, channel, target, success, statusCode, attempts, error, durationMs) {
  try {
    db.run(
      `INSERT INTO deliveries (event_id, channel, target, success, status_code, attempts, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId, channel, target, success ? 1 : 0, statusCode, attempts, error, durationMs, nowIso()
    );
  } catch (err) {
    log.error('recordDelivery', err.message);
  }
}

function testPayload(actor) {
  return {
    id: 'evt_test',
    event: 'test',
    label: LABELS.test,
    message: 'Ceci est un test de notification EZDocker.',
    timestamp: nowIso(),
    instance: { name: settings.get('instance_name'), host: settings.publicHost(), version: config.version },
    actor: actor ? { id: actor.id, username: actor.username } : null,
    site: null,
    deployment: null,
  };
}

async function testWebhook(actor, override = {}) {
  const s = { ...settings.all(), ...override };
  if (!s.webhook_url) throw new Error('Aucune URL de webhook configurée.');
  const r = await postWebhook(s.webhook_url, s.webhook_secret, testPayload(actor));
  return r;
}

async function testEmail(actor, to, override = {}) {
  const s = { ...settings.all(), ...override };
  if (!s.smtp_host) throw new Error('Aucun serveur SMTP configuré.');
  transport = null;
  await sendMail(s, to || s.smtp_to, testPayload(actor));
}

function cleanup() {
  const limit = new Date(Date.now() - 120 * 86400000).toISOString();
  db.run('DELETE FROM events WHERE created_at < ?', limit);
  db.run('DELETE FROM deliveries WHERE created_at < ?', limit);
}

module.exports = { LABELS, bus, emit, sign, testWebhook, testEmail, renderEmail, cleanup };
