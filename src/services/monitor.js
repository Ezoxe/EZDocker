const db = require('../db');
const docker = require('./docker');
const notifier = require('./notifier');
const { log } = require('../util');

// Containers we stop/remove on purpose: their "die" event must not raise a crash alert.
const intentional = new Map();
const lastCrashAlert = new Map();
const oomSites = new Set();
const CRASH_ALERT_INTERVAL = 10 * 60 * 1000;

let updateSite = null;
let stream = null;
let reconnectTimer = null;
let reconcileTimer = null;
let stopped = false;

function markIntentional(containerId) {
  if (containerId) intentional.set(containerId, Date.now() + 2 * 60 * 1000);
}

function isIntentional(containerId) {
  const until = intentional.get(containerId);
  if (!until) return false;
  if (until < Date.now()) {
    intentional.delete(containerId);
    return false;
  }
  return true;
}

function handleEvent(evt) {
  const action = evt.Action || evt.status;
  const id = evt.id || (evt.Actor && evt.Actor.ID);
  const attrs = (evt.Actor && evt.Actor.Attributes) || {};
  const siteId = Number(attrs[docker.LABEL_SITE]);
  if (!siteId || !id) return;
  const site = db.get('SELECT * FROM sites WHERE id = ?', siteId);
  if (!site || site.container_id !== id) return;

  if (action === 'oom') {
    oomSites.add(siteId);
    return;
  }

  if (action === 'die') {
    if (isIntentional(id) || site.status === 'stopped' || site.status === 'deploying') return;
    const oom = oomSites.delete(siteId);
    const code = attrs.exitCode ?? '?';
    const message = `Le conteneur s'est arrêté (code ${code}${oom ? ', mémoire insuffisante' : ''}). Redémarrage automatique…`;
    const fresh = updateSite(siteId, { status: 'error', status_message: message });
    const last = lastCrashAlert.get(siteId) || 0;
    if (Date.now() - last > CRASH_ALERT_INTERVAL) {
      lastCrashAlert.set(siteId, Date.now());
      notifier.emit('site.crashed', { site: fresh, message: `${site.name} : ${message}`, data: { exit_code: code, oom } });
    }
    return;
  }

  if (action === 'start' && site.status === 'error') {
    updateSite(siteId, { status: 'running', status_message: null });
  }
}

async function connect() {
  if (stopped) return;
  try {
    stream = await docker.getEvents({ type: ['container'], label: [docker.LABEL_SITE], event: ['die', 'start', 'oom'] });
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch (err) {
          log.warn('Événement Docker illisible', err.message);
        }
      }
    });
    const retry = () => scheduleReconnect(3000);
    stream.on('end', retry);
    stream.on('error', retry);
  } catch {
    scheduleReconnect(10000);
  }
}

function scheduleReconnect(ms) {
  if (stopped || reconnectTimer) return;
  stream = null;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, ms);
}

/** Aligns site statuses with real container states (events can be missed while EZDocker is down). */
async function reconcile() {
  const sites = db.all("SELECT * FROM sites WHERE container_id IS NOT NULL AND status != 'deploying'");
  for (const site of sites) {
    let info;
    try {
      info = await docker.inspectContainer(site.container_id);
    } catch {
      return; // Docker unreachable: try again later
    }
    if (!info) {
      updateSite(site.id, { status: 'error', status_message: 'Conteneur introuvable. Redéployez le site.' });
    } else if (info.State.Running && site.status === 'error') {
      updateSite(site.id, { status: 'running', status_message: null });
    } else if (!info.State.Running && site.status === 'running' && !isIntentional(info.Id)) {
      updateSite(site.id, { status: 'error', status_message: `Le conteneur est arrêté (code ${info.State.ExitCode}).` });
    }
  }
}

function start(options) {
  updateSite = options.updateSite;
  stopped = false;
  connect();
  reconcileTimer = setInterval(() => reconcile().catch(() => {}), 60000);
  reconcileTimer.unref();
}

function stop() {
  stopped = true;
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (stream && stream.destroy) stream.destroy();
}

module.exports = { start, stop, reconcile, markIntentional, isIntentional, handleEvent };
