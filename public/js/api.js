const handlers = { unauthorized: [], passwordRequired: [] };

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function onApi(event, fn) {
  handlers[event].push(fn);
}

function fire(event) {
  for (const fn of handlers[event]) fn();
}

function handleError(status, data) {
  const err = new ApiError(status, (data && data.error) || `Erreur ${status}`, data && data.code);
  if (status === 401 && err.code === 'UNAUTHENTICATED') fire('unauthorized');
  if (err.code === 'PASSWORD_CHANGE_REQUIRED') fire('passwordRequired');
  return err;
}

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'x-ezdocker': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const data = (res.headers.get('content-type') || '').includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw handleError(res.status, data);
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const patch = (path, body = {}) => api(path, { method: 'PATCH', body });
export const del = (path) => api(path, { method: 'DELETE' });

/** Multipart upload with progress (0-1). Returns { promise, abort }. */
export function upload(path, file, onProgress = () => {}) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/api' + path);
    xhr.setRequestHeader('x-ezdocker', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(handleError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, "L'envoi a échoué (connexion interrompue)."));
    xhr.onabort = () => reject(new ApiError(0, 'Envoi annulé.'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
