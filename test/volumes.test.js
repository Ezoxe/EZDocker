// Noms des volumes persistants des sites (Docker non requis).
const test = require('node:test');
const assert = require('node:assert/strict');
const docker = require('../src/services/docker');

test('un volume par site et par chemin déclaré, nom stable et sûr', () => {
  assert.equal(docker.volumeName(3, '/data'), 'ezd-site-3-data');
  assert.equal(docker.volumeName(3, '/data/'), 'ezd-site-3-data', 'même volume avec ou sans / final');
  assert.equal(docker.volumeName(3, '/var/lib/app data'), 'ezd-site-3-var_lib_app_data');
  assert.notEqual(docker.volumeName(3, '/data'), docker.volumeName(4, '/data'), 'deux sites ne partagent jamais un volume');
  assert.match(docker.volumeName(9, '/a/../../etc'), /^ezd-site-9-[a-zA-Z0-9_.-]+$/);
});
