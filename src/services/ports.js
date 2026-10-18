const net = require('net');
const config = require('../config');
const db = require('../db');
const settings = require('./settings');
const { HttpError } = require('../util');

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

const internalPort = (publicPort) => publicPort + config.internalPortOffset;

let lock = Promise.resolve();

// Serialized so two simultaneous site creations never get the same port.
function allocate() {
  const task = lock.then(async () => {
    const start = Number(settings.get('port_range_start'));
    const end = Number(settings.get('port_range_end'));
    const used = new Set(db.all('SELECT public_port FROM sites').map((r) => r.public_port));
    for (let port = start; port <= end; port++) {
      if (used.has(port)) continue;
      if (port === config.port) continue;
      if (!(await isPortFree(port))) continue;
      if (!(await isPortFree(internalPort(port), '127.0.0.1'))) continue;
      return port;
    }
    throw new HttpError(507, `Plus aucun port libre dans la plage ${start}-${end}.`, 'NO_PORT');
  });
  lock = task.catch(() => {});
  return task;
}

module.exports = { allocate, internalPort, isPortFree };
