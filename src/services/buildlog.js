// Readable BuildKit build logs.
//
// With BuildKit, the Docker API streams `{ id: 'moby.buildkit.trace', aux: '<base64 protobuf>' }` events.
// dockerode's own decoder turns the command output back into base64 text, so it is decoded here instead,
// with the schema shipped by dockerode, and printed like `docker build --progress=plain`.
const path = require('path');
const protobuf = require('protobufjs');

const TRACE_ID = 'moby.buildkit.trace';
const IMAGE_ID = 'moby.image.id';

let StatusResponse = null;
function schema() {
  if (!StatusResponse) {
    const proto = path.join(path.dirname(require.resolve('dockerode/package.json')), 'lib', 'proto', 'buildkit_status.proto');
    StatusResponse = protobuf.loadSync(proto).lookupType('moby.buildkit.v1.StatusResponse');
  }
  return StatusResponse;
}

/** Decodes one `aux` payload (base64 string) into { vertexes, logs }. */
function decodeTrace(aux) {
  if (!aux || typeof aux !== 'string') return { vertexes: [], logs: [] };
  const msg = schema().decode(Buffer.from(aux, 'base64'));
  return schema().toObject(msg, { longs: Number, bytes: Buffer, defaults: true });
}

/**
 * Stateful decoder for one build: each step is announced once (`#3 [2/7] RUN …`), its output follows
 * line by line, cached steps say so. Step errors are not repeated: the final build error reports them.
 */
function createDecoder() {
  const steps = new Map(); // digest -> { n, announced, cached }
  const partial = new Map(); // digest -> unterminated output line
  let counter = 0;

  const step = (digest) => {
    if (!steps.has(digest)) steps.set(digest, { n: ++counter, announced: false, cached: false });
    return steps.get(digest);
  };

  function push(aux) {
    let status;
    try {
      status = decodeTrace(aux);
    } catch {
      return '';
    }
    let out = '';
    for (const v of status.vertexes || []) {
      if (!v.digest || !v.name) continue;
      const s = step(v.digest);
      if (!s.announced && (v.started || v.cached)) {
        s.announced = true;
        out += `#${s.n} ${v.name}\n`;
      }
      if (v.cached && !s.cached) {
        s.cached = true;
        out += `#${s.n} CACHED\n`;
      }
    }
    for (const l of status.logs || []) {
      const text = (partial.get(l.vertex) || '') + Buffer.from(l.msg || []).toString('utf8');
      const cut = text.lastIndexOf('\n');
      if (cut === -1) {
        partial.set(l.vertex, text);
        continue;
      }
      partial.set(l.vertex, text.slice(cut + 1));
      out += text.slice(0, cut + 1).replace(/\r(?!\n)/g, '\n');
    }
    return out;
  }

  /** Output still waiting for its end of line. */
  function flush() {
    let out = '';
    for (const text of partial.values()) if (text) out += text + '\n';
    partial.clear();
    return out;
  }

  return { push, flush };
}

module.exports = { TRACE_ID, IMAGE_ID, decodeTrace, createDecoder };
