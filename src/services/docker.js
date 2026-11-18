const fs = require('fs');
const Docker = require('dockerode');
const config = require('../config');
const { stripAnsi } = require('../util');
const buildlog = require('./buildlog');

const NETWORK = 'ezdocker-sites';
const LABEL_SITE = 'ezdocker.site';
const LABEL_DEPLOYMENT = 'ezdocker.deployment';
const LABEL_VOLUME_PATH = 'ezdocker.volume.path';

const docker = new Docker({ socketPath: config.dockerSocket });

async function ping() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function engineInfo() {
  const [info, version] = await Promise.all([docker.info(), docker.version()]);
  return {
    version: version.Version,
    api_version: version.ApiVersion,
    os: info.OperatingSystem,
    kernel: info.KernelVersion,
    cpus: info.NCPU,
    memory: info.MemTotal,
    containers: info.Containers,
    containers_running: info.ContainersRunning,
    images: info.Images,
  };
}

async function ensureNetwork() {
  const nets = await docker.listNetworks({ filters: { name: [NETWORK] } });
  if (nets.some((n) => n.Name === NETWORK)) return;
  await docker.createNetwork({
    Name: NETWORK,
    Driver: 'bridge',
    // Sites cannot talk to each other.
    Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    Labels: { 'ezdocker.managed': 'true' },
  });
}

/** Text for one event of the build stream (legacy builder or BuildKit). Errors are reported by the caller. */
function describeBuildEvent(evt, decoder) {
  if (!evt || evt.error || evt.errorDetail) return '';
  if (evt.id === buildlog.TRACE_ID) return decoder ? decoder.push(evt.aux) : '';
  if (evt.id === buildlog.IMAGE_ID) return '';
  if (evt.stream) return evt.stream;
  if (evt.status) return `${evt.status}${evt.progress ? ' ' + evt.progress : ''}${evt.id ? ' ' + evt.id : ''}\n`;
  if (evt.aux && evt.aux.ID) return `Image construite : ${evt.aux.ID}\n`;
  return '';
}

/** True when Docker failed because the disk holding its data is full. */
const isNoSpaceError = (err) =>
  !!(err && err.diskFull) || /no space left on device|ENOSPC/i.test(String((err && err.message) || err || ''));

function dial(options) {
  return new Promise((resolve, reject) => docker.modem.dial(options, (err, data) => (err ? reject(err) : resolve(data))));
}

/**
 * Frees Docker disk space used by builds: BuildKit cache (all of it, or entries unused for `olderThan`,
 * e.g. '72h') and dangling images. Returns the reclaimed bytes. Running containers and tagged images are kept.
 */
async function pruneBuildSpace({ olderThan = null } = {}) {
  const options = olderThan ? { filters: { until: [olderThan] } } : { all: true };
  const cache = await dial({ path: '/build/prune?', method: 'POST', options, statusCodes: { 200: true, 500: 'server error' } }).catch(() => null);
  const images = await docker.pruneImages({ filters: { dangling: ['true'] } }).catch(() => null);
  return ((cache && cache.SpaceReclaimed) || 0) + ((images && images.SpaceReclaimed) || 0);
}

/** Builds an image from a directory. Resolves when the image exists, rejects with the build error. */
async function buildImage(contextDir, { tag, dockerfile = 'Dockerfile', labels = {}, onLog = () => {}, timeoutMs = config.buildTimeoutMs }) {
  const src = fs.readdirSync(contextDir);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const opts = {
    t: tag,
    dockerfile,
    labels,
    rm: true,
    forcerm: true,
    abortSignal: controller.signal,
  };
  if (config.builder !== 'legacy') opts.version = '2';

  // A command of the Dockerfile can fail because the disk is full while the final error only gives
  // its exit code (e.g. apk: "exit code: 7"): the build output tells.
  let diskFull = false;
  const emit = (text) => {
    if (!text) return;
    if (!diskFull && isNoSpaceError(text)) diskFull = true;
    onLog(stripAnsi(text));
  };

  try {
    const stream = await docker.buildImage({ context: contextDir, src }, opts);
    const decoder = buildlog.createDecoder();
    await new Promise((resolve, reject) => {
      let failure = null;
      docker.modem.followProgress(
        stream,
        (err) => {
          emit(decoder.flush());
          if (err) return reject(err);
          if (failure) return reject(new Error(failure));
          resolve();
        },
        (evt) => {
          emit(describeBuildEvent(evt, decoder));
          if (evt && (evt.error || evt.errorDetail)) failure = (evt.errorDetail && evt.errorDetail.message) || evt.error;
        }
      );
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Build interrompu : délai de ${Math.round(timeoutMs / 60000)} min dépassé.`);
    if (diskFull && err && typeof err === 'object') err.diskFull = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Make sure the tag really exists (some builder errors only show up here).
  await docker.getImage(tag).inspect();
}

async function imageExists(tag) {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

/** First exposed TCP port of the image, or null. */
async function imageExposedPort(tag) {
  const info = await docker.getImage(tag).inspect();
  const ports = Object.keys((info.Config && info.Config.ExposedPorts) || {})
    .filter((p) => p.endsWith('/tcp'))
    .map((p) => parseInt(p, 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return ports[0] || null;
}

/**
 * Persistent data: every VOLUME declared by the site's Dockerfile is backed by a named volume owned
 * by the site (`ezd-site-<id>-<path>`). The same volume is mounted again by every new deployment,
 * so databases and uploads survive updates and rollbacks; it is removed only with the site.
 */
function volumeName(siteId, target) {
  const slug = String(target).replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 60) || 'root';
  return `ezd-site-${siteId}-${slug}`;
}

/** Absolute paths declared with VOLUME in the image, sorted. */
async function imageVolumes(tag) {
  const info = await docker.getImage(tag).inspect();
  return Object.keys((info.Config && info.Config.Volumes) || {})
    .filter((p) => p.startsWith('/') && !p.includes('..'))
    .sort();
}

async function ensureSiteVolume(siteId, target) {
  const name = volumeName(siteId, target);
  try {
    await docker.getVolume(name).inspect();
  } catch (err) {
    if (err.statusCode !== 404) throw err;
    await docker.createVolume({ Name: name, Labels: { [LABEL_SITE]: String(siteId), [LABEL_VOLUME_PATH]: target } });
  }
  return { Type: 'volume', Source: name, Target: target };
}

async function listSiteVolumes(siteId) {
  const res = await docker.listVolumes({ filters: { label: [`${LABEL_SITE}=${siteId}`] } });
  return (res && res.Volumes) || [];
}

async function removeVolume(name) {
  await docker.getVolume(name).remove({ force: true }).catch((err) => {
    if (err.statusCode !== 404) throw err;
  });
}

async function inspectContainer(idOrName) {
  try {
    return await docker.getContainer(idOrName).inspect();
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function createSiteContainer({ name, image, containerPort, internalPort, env, memoryMb, cpus, siteId, deploymentId }) {
  const memory = Math.max(16, memoryMb) * 1024 * 1024;
  const mounts = [];
  for (const target of await imageVolumes(image)) mounts.push(await ensureSiteVolume(siteId, target));
  const container = await docker.createContainer({
    name,
    Image: image,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { [LABEL_SITE]: String(siteId), [LABEL_DEPLOYMENT]: String(deploymentId) },
    ExposedPorts: { [`${containerPort}/tcp`]: {} },
    HostConfig: {
      PortBindings: { [`${containerPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(internalPort) }] },
      Mounts: mounts,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(Math.max(0.1, cpus) * 1e9),
      PidsLimit: 512,
      SecurityOpt: ['no-new-privileges'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      NetworkMode: NETWORK,
    },
  });
  await container.start();
  return container.id;
}

const container = (id) => docker.getContainer(id);

async function startContainer(id) {
  await container(id).start().catch((err) => {
    if (err.statusCode !== 304) throw err;
  });
}

async function stopContainer(id, timeout = 10) {
  await container(id).stop({ t: timeout }).catch((err) => {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  });
}

async function restartContainer(id) {
  await container(id).restart({ t: 10 });
}

async function removeContainer(id) {
  await container(id).remove({ force: true }).catch((err) => {
    if (err.statusCode !== 404) throw err;
  });
}

async function renameContainer(id, name) {
  await container(id).rename({ name });
}

// Docker multiplexes stdout/stderr frames when no TTY: [stream, 0, 0, 0, size(4 bytes BE)] + payload.
function demux(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');
  if (buffer.length < 8 || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0 || buffer[0] > 2) {
    return buffer.toString('utf8');
  }
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

async function containerLogs(id, tail = 200) {
  const buf = await container(id).logs({ stdout: true, stderr: true, tail, timestamps: true });
  return stripAnsi(demux(buf));
}

async function containerStats(id) {
  const s = await container(id).stats({ stream: false });
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks || {})) {
    rx += n.rx_bytes || 0;
    tx += n.tx_bytes || 0;
  }
  return {
    cpu_percent: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * onlineCpus * 1000) / 10 : 0,
    memory_bytes: Math.max(0, (s.memory_stats?.usage || 0) - cache),
    memory_limit: s.memory_stats?.limit || 0,
    net_rx: rx,
    net_tx: tx,
    pids: s.pids_stats?.current || 0,
  };
}

async function listSiteImages(siteId) {
  return docker.listImages({ filters: { label: [`${LABEL_SITE}=${siteId}`] } });
}

async function removeImage(ref) {
  await docker.getImage(ref).remove({ force: true }).catch(() => {});
}

async function listSiteContainers() {
  return docker.listContainers({ all: true, filters: { label: [LABEL_SITE] } });
}

function getEvents(filters) {
  return docker.getEvents({ filters });
}

module.exports = {
  NETWORK,
  LABEL_SITE,
  LABEL_DEPLOYMENT,
  ping,
  engineInfo,
  ensureNetwork,
  buildImage,
  describeBuildEvent,
  isNoSpaceError,
  pruneBuildSpace,
  imageExists,
  imageExposedPort,
  inspectContainer,
  createSiteContainer,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  renameContainer,
  containerLogs,
  containerStats,
  listSiteImages,
  removeImage,
  listSiteContainers,
  volumeName,
  imageVolumes,
  listSiteVolumes,
  removeVolume,
  getEvents,
  demux,
};
