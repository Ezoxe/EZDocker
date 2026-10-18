// --- Safe templating -----------------------------------------------------------

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

export const raw = (s) => new Raw(String(s));

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export function mount(el, tpl) {
  el.innerHTML = render(tpl);
  animateCounters(el);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// --- Icons (lucide, MIT) ----------------------------------------------------------

const ICONS = {
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  rollback: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  hammer: '<path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0a2.12 2.12 0 0 1 0-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  drive: '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
};

export function icon(name, cls = '') {
  return raw(
    `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`
  );
}

// --- Formatting ---------------------------------------------------------------------

const nf = new Intl.NumberFormat('fr-FR');
export const fmtNumber = (n) => nf.format(Math.round(n || 0));

export function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? (s % 60) + ' s' : ''}`.trim();
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

export function timeAgo(iso) {
  if (!iso) return 'jamais';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 10) return "à l'instant";
  if (diff < 60) return `il y a ${Math.floor(diff)} s`;
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 30) return `il y a ${Math.floor(diff / 86400)} j`;
  return fmtDate(iso);
}

export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export const STATUS = {
  new: 'Nouveau',
  deploying: 'Déploiement…',
  running: 'En ligne',
  stopped: 'Arrêté',
  error: 'Erreur',
  queued: 'En attente',
  success: 'Réussi',
  failed: 'Échec',
};

export function badge(status, label) {
  const cls = status === 'running' && label ? 'building' : status;
  return html`<span class="badge ${cls}"><span class="dot"></span>${label || STATUS[status] || status}</span>`;
}

// --- Feedback ------------------------------------------------------------------------

export function toast(type, title, text = '', timeout = 4500) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = render(html`<div class="ico">${icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info')}</div>
    <div><b>${title}</b>${text ? html`<span>${text}</span>` : ''}</div>`);
  root.appendChild(el);
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', close);
  setTimeout(close, timeout);
}

export function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

/** Runs an async action with button spinner + error toast. */
export async function withButton(btn, fn) {
  setLoading(btn, true);
  try {
    return await fn();
  } catch (err) {
    toast('error', 'Oups', err.message);
    throw err;
  } finally {
    setLoading(btn, false);
  }
}

export function modal({ title, body, actions = [], wide = false, onMount, dismissable = true }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = render(html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${title}</h3>${dismissable ? html`<button class="btn ghost icon" data-close>${icon('x')}</button>` : ''}</div>
    <div class="modal-body">${body}</div>
    ${actions.length ? html`<div class="modal-foot">${actions.map(
      (a, i) => html`<button class="btn ${a.class || ''}" data-action="${i}">${a.icon ? icon(a.icon) : ''}${a.label}</button>`
    )}</div>` : ''}
  </div>`);
  root.appendChild(backdrop);
  const el = backdrop.querySelector('.modal');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => backdrop.remove(), 200);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissable) close();
  });
  el.querySelector('[data-close]')?.addEventListener('click', close);
  el.querySelectorAll('[data-action]').forEach((b) => {
    b.addEventListener('click', async () => {
      const a = actions[Number(b.dataset.action)];
      if (!a.onClick) return close();
      setLoading(b, true);
      try {
        const keep = await a.onClick({ el, close, button: b });
        if (keep !== true) close();
      } catch (err) {
        toast('error', 'Erreur', err.message);
      } finally {
        setLoading(b, false);
      }
    });
  });
  const first = el.querySelector('input:not([type=hidden]), select, textarea');
  if (first) setTimeout(() => first.focus(), 60);
  el.querySelectorAll('form').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      el.querySelector('.modal-foot .btn.primary, .modal-foot .btn.danger')?.click();
    })
  );
  if (onMount) onMount({ el, close });
  return { el, close };
}

export function confirmDialog({ title, text, confirmLabel = 'Confirmer', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    let ok = false;
    const { el } = modal({
      title,
      body: html`<p class="muted" style="margin-top:0">${text}</p>
        ${typeToConfirm
          ? html`<div class="field"><label>Tapez <b class="mono">${typeToConfirm}</b> pour confirmer</label>
              <input class="input" data-confirm autocomplete="off"></div>`
          : ''}`,
      actions: [
        { label: 'Annuler', class: 'ghost' },
        {
          label: confirmLabel,
          class: danger ? 'danger' : 'primary',
          onClick: () => {
            ok = true;
          },
        },
      ],
    });
    const btn = el.querySelector('[data-action="1"]');
    if (typeToConfirm) {
      btn.disabled = true;
      el.querySelector('[data-confirm]').addEventListener('input', (e) => {
        btn.disabled = e.target.value.trim() !== typeToConfirm;
      });
    }
    const observer = new MutationObserver(() => {
      if (!document.body.contains(el)) {
        observer.disconnect();
        resolve(ok);
      }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
  });
}

export function secretModal(title, text, secret) {
  modal({
    title,
    body: html`<p class="muted" style="margin-top:0">${text}</p>
      <div class="secret-box"><span>${secret}</span><button class="copy" data-copy="${secret}" title="Copier">${icon('copy')}</button></div>`,
    actions: [{ label: "C'est noté", class: 'primary' }],
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('success', 'Copié', text.length > 60 ? text.slice(0, 57) + '…' : text, 2200);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) {
    e.preventDefault();
    copyText(btn.dataset.copy);
  }
});

export function copyBtn(value) {
  return html`<button class="copy" data-copy="${value}" title="Copier">${icon('copy')}</button>`;
}

// --- Motion -------------------------------------------------------------------------

export function animateCounters(root) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const format = el.dataset.format === 'bytes' ? fmtBytes : fmtNumber;
    if (target === 0) {
      el.textContent = format(0);
      return;
    }
    const start = performance.now();
    const dur = 900;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(target * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function confetti(x = window.innerWidth / 2, y = window.innerHeight / 3) {
  const colors = ['#818cf8', '#22d3ee', '#22c55e', '#f59e0b', '#f472b6', '#ffffff'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 260;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--x0', `${x}px`);
    c.style.setProperty('--y0', `${y}px`);
    c.style.setProperty('--x1', `${x + Math.cos(angle) * dist}px`);
    c.style.setProperty('--y1', `${y + Math.sin(angle) * dist + 220}px`);
    c.style.setProperty('--r', `${Math.random() * 900 - 450}deg`);
    c.style.animationDelay = `${Math.random() * 120}ms`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 1900);
  }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function stagger(items) {
  return items.map((tpl, i) => html`<div style="--i:${i}">${tpl}</div>`);
}

export function formData(form) {
  const data = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') {
      if (el.dataset.list) {
        data[el.name] = data[el.name] || [];
        if (el.checked) data[el.name].push(el.value);
      } else data[el.name] = el.checked;
    } else if (el.type === 'number') data[el.name] = el.value === '' ? null : Number(el.value);
    else data[el.name] = el.value;
  }
  return data;
}
