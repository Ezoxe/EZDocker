import { upload } from '../api.js';
import { html, mount, icon, esc, raw, toast, confetti, fmtBytes, fmtDuration } from '../ui.js';

export function dropzone({ compact = false, title = 'Déposez votre archive .zip', subtitle = 'ou cliquez pour la choisir — un Dockerfile doit être à la racine' } = {}) {
  return html`<label class="dropzone ${compact ? 'compact' : ''}">
    <input type="file" accept=".zip,application/zip,application/x-zip-compressed">
    <div class="ico">${icon('upload')}</div>
    <div><b>${title}</b><span>${subtitle}</span></div>
  </label>`;
}

/** Wires drag & drop + file picker. onFile(file) is called with a validated .zip. */
export function bindDropzone(zone, onFile) {
  if (!zone) return;
  const input = zone.querySelector('input');
  const accept = (file) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast('error', 'Format refusé', 'Seules les archives .zip sont acceptées.');
      return;
    }
    onFile(file);
  };
  input.addEventListener('change', () => {
    accept(input.files[0]);
    input.value = '';
  });
  let depth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    zone.classList.add('drag');
  });
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      zone.classList.remove('drag');
    }
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('drag');
    accept(e.dataTransfer.files[0]);
  });
}

/** Uploads a zip to a site and shows progress inside `progressEl`. Resolves with the deployment. */
export async function uploadZip(slug, file, progressEl) {
  if (progressEl) {
    mount(progressEl, html`<div class="file-pill">${icon('archive')} ${file.name} · ${fmtBytes(file.size)} <b data-pct>0 %</b></div>
      <div class="progress"><span></span></div>`);
  }
  const bar = progressEl && progressEl.querySelector('.progress span');
  const pct = progressEl && progressEl.querySelector('[data-pct]');
  const { promise } = upload(`/sites/${encodeURIComponent(slug)}/deploy`, file, (p) => {
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    if (pct) pct.textContent = p >= 1 ? 'reçu ✓' : `${Math.round(p * 100)} %`;
  });
  try {
    const res = await promise;
    return res.deployment;
  } finally {
    if (progressEl) setTimeout(() => (progressEl.innerHTML = ''), 600);
  }
}

const BUILD_STEPS = [
  ['queued', 'Réception', 'inbox'],
  ['extract', 'Extraction', 'archive'],
  ['build', 'Construction', 'hammer'],
  ['start', 'Démarrage', 'rocket'],
  ['verify', 'Vérification', 'shield'],
  ['done', 'En ligne', 'globe'],
];
const QUICK_STEPS = BUILD_STEPS.filter(([k]) => !['extract', 'build'].includes(k));

function stepsFor(kind) {
  return ['rollback', 'config'].includes(kind) ? QUICK_STEPS : BUILD_STEPS;
}

function colorize(text) {
  return text
    .split('\n')
    .map((line) => {
      const safe = esc(line);
      if (/^(✓|✔)/.test(line)) return `<span class="ok">${safe}</span>`;
      if (/^(✖|ERREUR)/.test(line) || /\berror\b/i.test(line)) return `<span class="err">${safe}</span>`;
      if (/^(⚠|⏳|↺)/.test(line)) return `<span class="warn">${safe}</span>`;
      if (/^(▶|Step \d|#\d+ \[)/.test(line)) return `<span class="head">${safe}</span>`;
      return safe;
    })
    .join('\n');
}

export function renderLog(text) {
  return raw(colorize(text || ''));
}

/**
 * Live view of a deployment: animated steps + streaming build log.
 * Returns a cleanup function closing the stream.
 */
export function liveDeployment(container, slug, deployment, { onDone } = {}) {
  const steps = stepsFor(deployment.kind);
  mount(
    container,
    html`<div class="card" style="animation: rise .5s both">
      <div class="card-head">
        <h3>${icon('rocket')} Déploiement #${deployment.id} <span class="muted">· ${deployment.kind_label}</span></h3>
        <span data-badge>${raw('<span class="badge queued"><span class="dot"></span>En cours</span>')}</span>
      </div>
      <div class="steps">${steps.map(
        ([key, label, ic]) => html`<div class="step" data-step="${key}"><div class="bubble">${icon(ic)}</div>${label}</div>`
      )}</div>
      <div class="terminal" data-log><div class="terminal-bar"><i></i><i></i><i></i></div><div data-text></div><span class="cursor"></span></div>
    </div>`
  );
  const textEl = container.querySelector('[data-text]');
  const term = container.querySelector('[data-log]');
  const keys = steps.map(([k]) => k);
  let log = '';

  const stick = () => term.scrollHeight - term.scrollTop - term.clientHeight < 60;
  const setLog = (append) => {
    const atBottom = stick();
    log += append;
    textEl.innerHTML = colorize(log);
    if (atBottom) term.scrollTop = term.scrollHeight;
  };
  const setStep = (step, failed = false) => {
    let idx = keys.indexOf(step);
    if (idx < 0) idx = step === 'done' ? keys.length - 1 : 0;
    container.querySelectorAll('[data-step]').forEach((el, i) => {
      el.classList.toggle('done', i < idx || (step === 'done' && !failed));
      el.classList.toggle('active', i === idx && step !== 'done' && !failed);
      el.classList.toggle('failed', failed && i === idx);
    });
  };
  setStep(deployment.step || 'queued');

  const es = new EventSource(`/api/sites/${encodeURIComponent(slug)}/deployments/${deployment.id}/stream`);
  let lastStep = deployment.step || 'queued';
  let finished = false;
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      log = '';
      setLog(msg.deployment.log || '');
      lastStep = msg.deployment.step || lastStep;
      setStep(lastStep);
    } else if (msg.type === 'log') setLog(msg.text);
    else if (msg.type === 'step') {
      lastStep = msg.step;
      setStep(msg.step);
    } else if (msg.type === 'done') {
      finished = true;
      es.close();
      container.querySelector('.cursor')?.remove();
      const ok = msg.status === 'success';
      setStep(ok ? 'done' : lastStep, !ok);
      container.querySelector('[data-badge]').innerHTML = ok
        ? '<span class="badge success"><span class="dot"></span>Réussi</span>'
        : '<span class="badge failed"><span class="dot"></span>Échec</span>';
      if (ok) {
        const r = container.getBoundingClientRect();
        confetti(r.left + r.width / 2, r.top + 40);
        toast('success', 'Déploiement réussi 🎉', 'Votre site est en ligne.');
      } else {
        toast('error', 'Le déploiement a échoué', msg.error || 'Consultez le journal.', 7000);
      }
      onDone && onDone(msg);
    }
  };
  es.onerror = () => {
    if (finished) es.close();
  };
  return () => es.close();
}

export function deploymentDuration(d) {
  if (d.duration_ms != null) return fmtDuration(d.duration_ms);
  return d.status === 'running' || d.status === 'queued' ? '…' : '—';
}
