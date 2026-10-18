const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const proxy = require('../src/services/proxy');
const notifier = require('../src/services/notifier');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, path = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

const records = [];
proxy.setRecorder((siteId, r) => records.push({ siteId, ...r }));

let upstream;
let firstPublicPort;
after(() => {
  proxy.closeAll();
  if (upstream) upstream.close();
});

test('forwards requests, keeps headers and records stats', async () => {
  const internal = await freePort();
  const publicPort = await freePort();
  firstPublicPort = publicPort;
  upstream = http
    .createServer((req, res) => {
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.setHeader('content-type', 'text/plain');
      res.end(`hello ${req.url} from ${req.headers['x-forwarded-for']}`);
    })
    .listen(internal, '127.0.0.1');

  await proxy.ensure({ id: 1, name: 'Test', public_port: publicPort, internal_port: internal, mode: 'proxy' });
  const res = await request(publicPort, '/page?x=1');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /hello \/page\?x=1 from 127\.0\.0\.1/);
  assert.deepStrictEqual(res.headers['set-cookie'], ['a=1', 'b=2']);

  await new Promise((r) => setTimeout(r, 50));
  const rec = records.find((r) => r.path === '/page?x=1');
  assert.ok(rec, 'request recorded');
  assert.strictEqual(rec.siteId, 1);
  assert.strictEqual(rec.status, 200);
  assert.ok(rec.bytesOut > 0);
});

test('serves a friendly page when the site is stopped', async () => {
  proxy.setMode(1, 'stopped');
  const res = await request(firstPublicPort);
  assert.strictEqual(res.status, 503);
  assert.match(res.body, /Site arrêté/);
  proxy.setMode(1, 'proxy');
  assert.strictEqual((await request(firstPublicPort)).status, 200);
});

test('returns 502 page when the upstream is down', async () => {
  const internal = await freePort();
  const publicPort = await freePort();
  await proxy.ensure({ id: 2, name: 'Down', public_port: publicPort, internal_port: internal, mode: 'proxy' });
  const res = await request(publicPort);
  assert.strictEqual(res.status, 502);
  assert.match(res.body, /ne répond pas/);
});

test('pending sites answer 503 with an explanation', async () => {
  const publicPort = await freePort();
  await proxy.ensure({ id: 3, name: 'New', public_port: publicPort, internal_port: 1, mode: 'pending' });
  const res = await request(publicPort);
  assert.strictEqual(res.status, 503);
  assert.match(res.body, /premier déploiement/);
});

test('webhook signature is a sha256 HMAC of the body', () => {
  const crypto = require('crypto');
  const body = JSON.stringify({ event: 'site.updated' });
  const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.strictEqual(notifier.sign('s3cret', body), expected);
});
