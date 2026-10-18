const { DatabaseSync } = require('node:sqlite');

let db = null;

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    max_sites INTEGER NOT NULL DEFAULT 3,
    max_memory_mb INTEGER NOT NULL DEFAULT 512,
    max_cpus REAL NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    public_port INTEGER NOT NULL UNIQUE,
    container_port INTEGER,
    detected_port INTEGER,
    env_json TEXT NOT NULL DEFAULT '{}',
    memory_mb INTEGER NOT NULL DEFAULT 512,
    cpus REAL NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'new',
    status_message TEXT,
    container_id TEXT,
    image TEXT,
    current_deployment_id INTEGER,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_bytes_out INTEGER NOT NULL DEFAULT 0,
    last_access_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_deployed_at TEXT
  );

  CREATE TABLE deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'web',
    status TEXT NOT NULL DEFAULT 'queued',
    step TEXT,
    zip_name TEXT,
    zip_size INTEGER,
    image TEXT,
    error TEXT,
    log TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX deployments_site ON deployments(site_id, id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    site_id INTEGER,
    owner_id INTEGER,
    message TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_site ON events(site_id, id);
  CREATE INDEX events_owner ON events(owner_id, id);

  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER,
    channel TEXT NOT NULL,
    target TEXT,
    success INTEGER NOT NULL,
    status_code INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE stats_hourly (
    site_id INTEGER NOT NULL,
    hour TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    s2xx INTEGER NOT NULL DEFAULT 0,
    s3xx INTEGER NOT NULL DEFAULT 0,
    s4xx INTEGER NOT NULL DEFAULT 0,
    s5xx INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, hour)
  ) WITHOUT ROWID;

  CREATE TABLE visitors_daily (
    site_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    PRIMARY KEY (site_id, day, ip_hash)
  ) WITHOUT ROWID;
  `,
];

function open(file) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate();
  return db;
}

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function close() {
  if (db) db.close();
  db = null;
}

const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

function run(sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, close, get, all, run, tx };
