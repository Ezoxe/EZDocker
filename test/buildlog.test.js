// Décodage des journaux de build BuildKit (Docker non requis).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const protobuf = require('protobufjs');
const buildlog = require('../src/services/buildlog');
const docker = require('../src/services/docker');

const proto = path.join(path.dirname(require.resolve('dockerode/package.json')), 'lib', 'proto', 'buildkit_status.proto');
const StatusResponse = protobuf.loadSync(proto).lookupType('moby.buildkit.v1.StatusResponse');
const encode = (status) => Buffer.from(StatusResponse.encode(StatusResponse.fromObject(status)).finish()).toString('base64');
const trace = (status) => ({ id: buildlog.TRACE_ID, aux: encode(status) });

test('la sortie des commandes est du texte lisible, pas du base64', () => {
  const decoder = buildlog.createDecoder();
  const run = { digest: 'sha256:aaa', name: '[2/7] RUN apk add --no-cache chromium', started: { seconds: 1 } };
  let out = docker.describeBuildEvent(trace({ vertexes: [run] }), decoder);
  out += docker.describeBuildEvent(trace({
    logs: [
      { vertex: 'sha256:aaa', msg: Buffer.from('(  1/184) Installing chromium-angle (156.0)\n') },
      { vertex: 'sha256:aaa', msg: Buffer.from('OK: 795.7 MiB ') },
      { vertex: 'sha256:aaa', msg: Buffer.from('in 203 packages\n') },
    ],
  }), decoder);
  assert.equal(out, '#1 [2/7] RUN apk add --no-cache chromium\n(  1/184) Installing chromium-angle (156.0)\nOK: 795.7 MiB in 203 packages\n');
});

test('chaque étape est annoncée une seule fois, les étapes en cache le disent', () => {
  const decoder = buildlog.createDecoder();
  const from = { digest: 'sha256:bbb', name: '[1/7] FROM node:24-alpine', started: { seconds: 1 } };
  let out = decoder.push(encode({ vertexes: [from] }));
  out += decoder.push(encode({ vertexes: [{ ...from, cached: true, completed: { seconds: 2 } }] }));
  out += decoder.push(encode({ vertexes: [{ ...from, cached: true, completed: { seconds: 2 } }] }));
  assert.equal(out, '#1 [1/7] FROM node:24-alpine\n#1 CACHED\n');
});

test('une ligne sans fin est rendue à la fin du build', () => {
  const decoder = buildlog.createDecoder();
  assert.equal(decoder.push(encode({ logs: [{ vertex: 'sha256:c', msg: Buffer.from('dernière ligne') }] })), '');
  assert.equal(decoder.flush(), 'dernière ligne\n');
  assert.equal(decoder.flush(), '');
});

test('les erreurs ne sont pas répétées dans le journal, une trace illisible est ignorée', () => {
  const decoder = buildlog.createDecoder();
  assert.equal(docker.describeBuildEvent({ error: 'boom', errorDetail: { message: 'boom' } }, decoder), '');
  assert.equal(docker.describeBuildEvent({ id: buildlog.TRACE_ID, aux: '%%%pas du protobuf' }, decoder), '');
  assert.equal(docker.describeBuildEvent({ stream: 'Step 1/3 : FROM alpine\n' }), 'Step 1/3 : FROM alpine\n');
});

test('détection du disque plein', () => {
  assert.ok(docker.isNoSpaceError(new Error('mkdir /app/site/public/vendor: no space left on device')));
  assert.ok(docker.isNoSpaceError('write /var/lib/containerd/…/data: No space left on device'));
  assert.ok(!docker.isNoSpaceError(new Error('failed to solve: exit code 1')));
  // apk ne renvoie que son code de sortie : le build marque l'erreur quand sa sortie parlait de disque plein.
  const apk = Object.assign(new Error('process "/bin/sh -c apk add chromium" did not complete successfully: exit code: 7'), { diskFull: true });
  assert.ok(docker.isNoSpaceError(apk));
});

test('taille lisible', () => {
  const { formatBytes } = require('../src/services/deployer');
  assert.equal(formatBytes(0), '0 o');
  assert.equal(formatBytes(512), '512 o');
  assert.equal(formatBytes(3.5 * 1024 ** 3), '3,5 Go');
});
