const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}

const nowIso = () => new Date().toISOString();
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const isValidSlug = (slug) => SLUG_RE.test(slug);

// Readable random password: no ambiguous characters.
function generatePassword(length = 14) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');

function ts() {
  return new Date().toISOString();
}

const log = {
  info: (...args) => console.log(ts(), '[info]', ...args),
  warn: (...args) => console.warn(ts(), '[warn]', ...args),
  error: (...args) => console.error(ts(), '[error]', ...args),
};

// Wraps async express handlers so rejections reach the error middleware.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  HttpError,
  nowIso,
  randomToken,
  sha256,
  sleep,
  slugify,
  isValidSlug,
  generatePassword,
  stripAnsi,
  log,
  asyncRoute,
};
