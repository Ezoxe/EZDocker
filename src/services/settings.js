const os = require('os');
const config = require('../config');
const db = require('../db');
const { randomToken } = require('../util');

const ALL_EVENTS = [
  'site.created',
  'deployment.started',
  'site.deployed',
  'site.updated',
  'site.deploy_failed',
  'site.crashed',
  'site.started',
  'site.stopped',
  'site.deleted',
];

const DEFAULTS = {
  instance_name: 'EZDocker',
  public_host: '',
  port_range_start: 10000,
  port_range_end: 19999,
  max_upload_mb: 200,
  default_max_sites: 3,
  default_memory_mb: 512,
  default_cpus: 1,
  webhook_enabled: false,
  webhook_url: '',
  webhook_secret: '',
  webhook_events: ALL_EVENTS,
  smtp_enabled: false,
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  smtp_to: '',
  smtp_events: ['site.deployed', 'site.updated', 'site.deploy_failed', 'site.crashed'],
  stats_salt: '',
};

let cache = null;

function load() {
  cache = { ...DEFAULTS };
  for (const row of db.all('SELECT key, value FROM settings')) {
    try {
      cache[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore corrupt value, keep default */
    }
  }
  return cache;
}

function init() {
  load();
  const first = {};
  if (!cache.stats_salt) first.stats_salt = randomToken(16);
  if (!cache.webhook_secret) first.webhook_secret = randomToken(24);
  if (!db.get("SELECT 1 FROM settings WHERE key = 'port_range_start'")) {
    first.port_range_start = config.initialPortRange[0];
    first.port_range_end = config.initialPortRange[1];
  }
  if (!db.get("SELECT 1 FROM settings WHERE key = 'public_host'") && config.initialPublicHost) {
    first.public_host = config.initialPublicHost;
  }
  if (Object.keys(first).length) set(first);
}

function get(key) {
  if (!cache) load();
  return cache[key];
}

function all() {
  if (!cache) load();
  return { ...cache };
}

function set(values) {
  db.tx(() => {
    for (const [k, v] of Object.entries(values)) {
      db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        k, JSON.stringify(v)
      );
    }
  });
  load();
}

// First non-internal IPv4, ignoring Docker bridges and virtual interfaces.
function detectHostIp() {
  const ifaces = os.networkInterfaces();
  const skip = /^(docker|br-|veth|virbr|lo|cni|flannel|tun|tap|zt)/;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

function publicHost() {
  return get('public_host') || config.initialPublicHost || detectHostIp();
}

module.exports = { ALL_EVENTS, DEFAULTS, init, get, all, set, publicHost, detectHostIp };
