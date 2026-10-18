const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { extractZip } = require('../src/services/zip');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ezd-zip-'));
}

function makeZip(entries) {
  const dir = tmp();
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  const file = path.join(dir, 'site.zip');
  zip.writeZip(file);
  return file;
}

test('extracts a zip with a Dockerfile at the root', () => {
  const file = makeZip({ Dockerfile: 'FROM nginx:alpine', 'index.html': '<h1>hi</h1>', 'assets/app.css': 'body{}' });
  const dest = tmp();
  const { contextDir, dockerfile } = extractZip(file, dest);
  assert.strictEqual(contextDir, path.resolve(dest));
  assert.strictEqual(dockerfile, 'Dockerfile');
  assert.ok(fs.existsSync(path.join(dest, 'assets', 'app.css')));
});

test('accepts a single top-level folder containing the Dockerfile', () => {
  const file = makeZip({ 'my-site/Dockerfile': 'FROM nginx', 'my-site/index.html': 'x' });
  const dest = tmp();
  const { contextDir } = extractZip(file, dest);
  assert.strictEqual(contextDir, path.join(path.resolve(dest), 'my-site'));
});

test('finds a lowercase dockerfile', () => {
  const file = makeZip({ dockerfile: 'FROM nginx' });
  const { dockerfile } = extractZip(file, tmp());
  assert.strictEqual(dockerfile, 'dockerfile');
});

test('rejects an archive without Dockerfile', () => {
  const file = makeZip({ 'index.html': 'x' });
  assert.throws(() => extractZip(file, tmp()), (err) => err.code === 'NO_DOCKERFILE');
});

test('rejects path traversal entries', () => {
  const file = makeZip({ Dockerfile: 'FROM nginx', 'safe.txt': 'x' });
  // Rewrite an entry name to escape the destination folder.
  const buf = fs.readFileSync(file);
  const patched = Buffer.from(buf.toString('latin1').split('safe.txt').join('../e.txt'), 'latin1');
  fs.writeFileSync(file, patched);
  const dest = tmp();
  assert.throws(() => extractZip(file, dest), (err) => err.code === 'ZIP_BAD_PATH');
  assert.ok(!fs.existsSync(path.join(dest, '..', 'e.txt')));
});

test('rejects files that are not zips', () => {
  const dir = tmp();
  const file = path.join(dir, 'fake.zip');
  fs.writeFileSync(file, 'definitely not a zip');
  assert.throws(() => extractZip(file, tmp()), (err) => err.code === 'INVALID_ZIP');
});

test('enforces the uncompressed size limit', () => {
  const file = makeZip({ Dockerfile: 'FROM nginx', 'big.bin': 'a'.repeat(5000) });
  assert.throws(() => extractZip(file, tmp(), { maxTotalBytes: 1000 }), (err) => err.code === 'ZIP_TOO_LARGE');
});
