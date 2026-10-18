const path = require('path');
const pkg = require('../package.json');

const env = process.env;

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseRange(value, fallback) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(value || '');
  if (!m) return fallback;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

const dataDir = path.resolve(env.EZD_DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  version: pkg.version,
  host: env.EZD_HOST || '0.0.0.0',
  port: int(env.EZD_PORT, 3000),
  dataDir,
  dbFile: path.join(dataDir, 'ezdocker.db'),
  publicDir: path.join(__dirname, '..', 'public'),
  examplesDir: path.join(__dirname, '..', 'examples'),
  dockerSocket: env.DOCKER_SOCKET || (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),
  // Host the per-site proxy uses to reach containers (published on 127.0.0.1:internalPort).
  upstreamHost: env.EZD_UPSTREAM_HOST || '127.0.0.1',
  // Internal (loopback) port = public port + offset. Keep the sum below 32768 (Linux ephemeral range).
  internalPortOffset: int(env.EZD_INTERNAL_OFFSET, 10000),
  initialPortRange: parseRange(env.EZD_PORT_RANGE, [10000, 19999]),
  initialPublicHost: env.EZD_PUBLIC_HOST || '',
  adminUser: env.EZD_ADMIN_USER || 'admin',
  adminPassword: env.EZD_ADMIN_PASSWORD || '',
  adminEmail: env.EZD_ADMIN_EMAIL || '',
  // 'buildkit' (default) or 'legacy'
  builder: (env.EZD_BUILDER || 'buildkit').toLowerCase(),
  buildTimeoutMs: int(env.EZD_BUILD_TIMEOUT, 15 * 60) * 1000,
  maxConcurrentBuilds: int(env.EZD_MAX_BUILDS, 2),
  secureCookies: env.EZD_SECURE_COOKIES === '1',
  trustProxy: env.EZD_TRUST_PROXY === '1',
  sessionDays: int(env.EZD_SESSION_DAYS, 7),
};
