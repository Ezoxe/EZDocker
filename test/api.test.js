// HTTP API tests against a real Express app and SQLite database (Docker not required).
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezd-api-'));
process.env.EZD_DATA_DIR = dataDir;
process.env.EZD_ADMIN_PASSWORD = 'admin-password-1';
process.env.EZD_PORT_RANGE = '21500-21600';
process.env.DOCKER_SOCKET = path.join(dataDir, 'no-docker.sock');

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const auth = require('../src/auth');
const settings = require('../src/services/settings');
const proxy = require('../src/services/proxy');
const { createApp } = require('../src/server');

let server;
let base;

class Client {
  constructor() {
    this.cookie = '';
    this.token = null;
  }
  async req(method, url, body) {
    const headers = { 'x-ezdocker': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
}

before(async () => {
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  db.open(config.dbFile);
  settings.init();
  db.run(
    `INSERT INTO users (username, password_hash, role, max_sites, max_memory_mb, max_cpus, created_at)
     VALUES ('admin', ?, 'superadmin', 1000, 65536, 64, ?)`,
    auth.hashPassword('admin-password-1'), new Date().toISOString()
  );
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  proxy.closeAll();
  server.close();
  db.close();
});

const admin = new Client();
const bob = new Client();
let bobPassword;

test('health is public', async () => {
  const r = await new Client().get('/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
});

test('rejects bad credentials and anonymous access', async () => {
  const c = new Client();
  assert.strictEqual((await c.post('/auth/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.strictEqual((await c.get('/sites')).status, 401);
});

test('admin logs in', async () => {
  const r = await admin.post('/auth/login', { username: 'admin', password: 'admin-password-1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.role, 'superadmin');
});

test('mutations without the CSRF header are refused', async () => {
  const res = await fetch(base + '/sites', {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.strictEqual(res.status, 403);
});

test('admin creates a user with a generated password', async () => {
  const r = await admin.post('/admin/users', { username: 'bob', email: 'bob@example.com', max_sites: 1 });
  assert.strictEqual(r.status, 201);
  assert.ok(r.data.password.length >= 12);
  assert.strictEqual(r.data.user.must_change_password, true);
  bobPassword = r.data.password;
});

test('regular users cannot reach admin routes', async () => {
  await bob.post('/auth/login', { username: 'bob', password: bobPassword });
  assert.strictEqual((await bob.get('/sites')).data.code, 'PASSWORD_CHANGE_REQUIRED');
  const changed = await bob.post('/account/password', { current_password: bobPassword, new_password: 'bob-new-password' });
  assert.strictEqual(changed.status, 200);
  assert.strictEqual((await bob.get('/admin/users')).status, 403);
});

test('user creates a site and gets a port in the range', async () => {
  const r = await bob.post('/sites', { name: 'Mon Portfolio' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.site.slug, 'mon-portfolio');
  assert.ok(r.data.site.public_port >= 21500 && r.data.site.public_port <= 21600);
  assert.strictEqual(r.data.site.internal_port, r.data.site.public_port + 10000);
  assert.strictEqual(r.data.site.proxy.listening, true);
});

test('site limit is enforced', async () => {
  const r = await bob.post('/sites', { name: 'Second' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.code, 'SITE_LIMIT');
});

test('users only see their own sites, admin sees all', async () => {
  await admin.post('/sites', { name: 'Admin Site' });
  const mine = await bob.get('/sites');
  assert.deepStrictEqual(mine.data.sites.map((s) => s.slug), ['mon-portfolio']);
  const all = await admin.get('/sites');
  assert.strictEqual(all.data.sites.length, 2);
  assert.strictEqual((await bob.get('/sites/admin-site')).status, 404);
});

test('site settings are validated', async () => {
  assert.strictEqual((await bob.patch('/sites/mon-portfolio', { memory_mb: 999999 })).status, 400);
  assert.strictEqual((await bob.patch('/sites/mon-portfolio', { env: { 'bad key': 'x' } })).status, 400);
  const ok = await bob.patch('/sites/mon-portfolio', { env: { API_URL: 'https://x' }, container_port: 3000 });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.data.site.env, { API_URL: 'https://x' });
  assert.strictEqual(ok.data.needs_redeploy, false);
});

test('API tokens authenticate without CSRF header', async () => {
  const created = await bob.post('/account/tokens', { name: 'CI' });
  assert.strictEqual(created.status, 201);
  assert.match(created.data.token, /^ezd_/);
  const res = await fetch(base + '/sites', { headers: { authorization: `Bearer ${created.data.token}` } });
  assert.strictEqual(res.status, 200);
  const bad = await fetch(base + '/sites', { headers: { authorization: 'Bearer ezd_wrong' } });
  assert.strictEqual(bad.status, 401);
});

test('upload rejects non-zip files', async () => {
  const form = new FormData();
  form.append('file', new Blob(['hello']), 'site.txt');
  const res = await fetch(base + '/sites/mon-portfolio/deploy', { method: 'POST', headers: { cookie: bob.cookie, 'x-ezdocker': '1' }, body: form });
  assert.strictEqual(res.status, 400);
});

test('events are recorded and filtered per owner', async () => {
  const bobEvents = await bob.get('/events?since=0');
  assert.ok(bobEvents.data.events.every((e) => e.site.owner === 'bob'));
  assert.ok(bobEvents.data.events.some((e) => e.event === 'site.created'));
  const all = await admin.get('/events?since=0');
  assert.ok(all.data.events.length > bobEvents.data.events.length);
});

test('settings are validated and secrets masked', async () => {
  assert.strictEqual((await admin.put('/admin/settings', { webhook_url: 'ftp://x' })).status, 400);
  const r = await admin.put('/admin/settings', { smtp_pass: 'secret', webhook_url: 'https://hooks.example.com/x', port_range_start: 21500, port_range_end: 21700 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.settings.smtp_pass, '••••••••');
  assert.strictEqual(r.data.settings.stats_salt, undefined);
});

test('stats endpoint returns 24 hourly buckets', async () => {
  const r = await bob.get('/sites/mon-portfolio/stats');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.hourly.length, 24);
  assert.strictEqual(r.data.daily.length, 14);
});

test('deleting a user removes their sites', async () => {
  const users = (await admin.get('/admin/users')).data.users;
  const bobId = users.find((u) => u.username === 'bob').id;
  const r = await admin.del(`/admin/users/${bobId}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.deleted_sites, 1);
  assert.strictEqual((await admin.get('/sites')).data.sites.length, 1);
});
