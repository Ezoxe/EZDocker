import { get, post, patch, del } from '../api.js';
import {
  html, mount, icon, badge, toast, modal, confirmDialog, withButton, copyBtn, fmtNumber, fmtBytes, fmtDate,
  fmtDuration, timeAgo, $, $$,
} from '../ui.js';
import { barChart, statusBar } from '../charts.js';
import { navigate, isAdmin } from '../app.js';
import { dropzone, bindDropzone, uploadZip, liveDeployment, renderLog, deploymentDuration } from './deploy.js';

const TABS = [
  ['overview', 'Aperçu', 'eye'],
  ['deployments', 'Déploiements', 'rocket'],
  ['logs', 'Logs', 'terminal'],
  ['stats', 'Statistiques', 'chart'],
  ['settings', 'Paramètres', 'sliders'],
];

function uptime(iso) {
  if (!iso || iso.startsWith('0001')) return '—';
  return fmtDuration(Date.now() - new Date(iso).getTime());
}

function header(site, runtime, busy) {
  const running = site.status === 'running' || (site.status === 'error' && runtime && runtime.running);
  return html`
    <a class="back" href="#/">${icon('back')} ${isAdmin() ? 'Tous les sites' : 'Mes sites'}</a>
    <div class="page-head">
      <div>
        <div class="row"><h1>${site.name}</h1>${badge(busy ? 'deploying' : site.status)}</div>
        <p class="mono small">${site.slug}${isAdmin() ? html` · ${icon('user', 'dim')} ${site.owner}` : ''}</p>
      </div>
      <div class="actions">
        ${site.container_id
          ? html`${running || site.status === 'error'
              ? html`<button class="btn" data-act="stop" ${busy ? 'disabled' : ''}>${icon('stop')} Arrêter</button>`
              : html`<button class="btn success" data-act="start" ${busy ? 'disabled' : ''}>${icon('play')} Démarrer</button>`}
            <button class="btn" data-act="restart" ${busy ? 'disabled' : ''}>${icon('refresh')} Redémarrer</button>
            <button class="btn" data-act="rebuild" ${busy ? 'disabled' : ''} title="Reconstruire l'image depuis la dernière archive">${icon('hammer')} Reconstruire</button>`
          : ''}
        <a class="btn primary" href="${site.url}" target="_blank" rel="noopener">${icon('external')} Ouvrir</a>
      </div>
    </div>
    <div class="url-hero">
      <div class="globe">${icon('globe')}</div>
      <div class="grow"><div class="small muted">Adresse publique</div><a href="${site.url}" target="_blank" rel="noopener">${site.url}</a></div>
      ${copyBtn(site.url)}
      <span class="badge">IP ${site.host}</span><span class="badge">Port ${site.public_port}</span>
    </div>
    ${site.status_message
      ? html`<div class="alert ${site.status === 'error' ? 'error' : 'warning'}">${icon('alert')}<div>${site.status_message}</div></div>`
      : ''}
    ${site.proxy && site.proxy.error
      ? html`<div class="alert error">${icon('alert')}<div>Le port public ${site.public_port} n'a pas pu être ouvert (${site.proxy.error}).</div></div>`
      : ''}
    <div class="tabs">${TABS.map(
      ([key, label, ic]) => html`<a class="tab" href="#/sites/${site.slug}/${key}" data-tab="${key}">${icon(ic)}${label}</a>`
    )}</div>`;
}

function infoItem(k, v, copy = null) {
  return html`<div class="item"><span class="k">${k}</span><span class="v">${v ?? '—'}${copy ? copyBtn(copy) : ''}</span></div>`;
}

function techCard(site, rt) {
  return html`<div class="card"><h3>${icon('server')} Infos techniques</h3>
    <div class="info">
      ${infoItem('IP du serveur', site.host, site.host)}
      ${infoItem('Port public', site.public_port, String(site.public_port))}
      ${infoItem('Port de l’application', site.effective_port ? `${site.effective_port}/tcp` : 'auto')}
      ${infoItem('Port interne (loopback)', `127.0.0.1:${site.internal_port}`)}
      ${infoItem('IP du conteneur', rt && rt.ip, rt && rt.ip)}
      ${infoItem('Réseau', rt ? rt.network : '—')}
      ${infoItem('Conteneur', rt && rt.exists ? `${rt.name} (${rt.short_id})` : site.container_name, rt && rt.id)}
      ${infoItem('Image', site.image, site.image)}
      ${infoItem('Démarré depuis', rt && rt.running ? uptime(rt.started_at) : rt && rt.exists ? `arrêté (code ${rt.exit_code})` : '—')}
      ${infoItem('Redémarrages', rt && rt.exists ? rt.restart_count : '—')}
      ${infoItem('Dernier déploiement', site.last_deployed_at ? fmtDate(site.last_deployed_at) : 'jamais')}
      ${infoItem('Dernier accès', site.last_access_at ? timeAgo(site.last_access_at) : 'jamais')}
    </div>
  </div>`;
}

function resourcesCard(site, rt) {
  const st = rt && rt.stats;
  const limit = site.memory_mb * 1024 * 1024;
  const memPct = st ? Math.min(100, (st.memory_bytes / (st.memory_limit || limit)) * 100) : 0;
  const cpuPct = st ? Math.min(100, st.cpu_percent / Math.max(site.cpus, 0.01)) : 0;
  return html`<div class="card"><h3>${icon('cpu')} Ressources</h3>
    ${st
      ? html`<div class="field"><div class="row between small"><span class="muted">CPU</span><span class="mono">${st.cpu_percent.toFixed(1)} % (limite ${site.cpus} CPU)</span></div>
          <div class="meter ${cpuPct > 85 ? 'warn' : ''}"><span style="width:${cpuPct}%"></span></div></div>
        <div class="field"><div class="row between small"><span class="muted">Mémoire</span><span class="mono">${fmtBytes(st.memory_bytes)} / ${fmtBytes(st.memory_limit || limit)}</span></div>
          <div class="meter ${memPct > 85 ? 'warn' : ''}"><span style="width:${memPct}%"></span></div></div>
        <div class="row between small muted"><span>Réseau ↓ ${fmtBytes(st.net_rx)} · ↑ ${fmtBytes(st.net_tx)}</span><span>${st.pids} processus</span></div>`
      : html`<p class="muted small" style="margin:0">Limites : ${site.memory_mb} Mo de RAM, ${site.cpus} CPU. Les mesures s'affichent quand le site tourne.</p>`}
  </div>`;
}

function statsKpis(s) {
  return html`<div class="kpis stagger">
    <div class="kpi" style="--i:0"><div class="label">${icon('activity')} Requêtes 24 h</div><div class="value" data-count="${s.requests_24h}"></div>
      <div class="sub">${fmtNumber(s.requests_total)} au total</div></div>
    <div class="kpi" style="--i:1;--kpi-color:#22d3ee"><div class="label">${icon('users')} Visiteurs uniques 24 h</div><div class="value" data-count="${s.visitors_24h}"></div>
      <div class="sub">${fmtNumber(s.visitors_today)} aujourd'hui</div></div>
    <div class="kpi" style="--i:2;--kpi-color:#f472b6"><div class="label">${icon('zap')} Bande passante 24 h</div><div class="value" data-count="${s.bytes_out_24h}" data-format="bytes"></div>
      <div class="sub">${fmtBytes(s.bytes_out_total)} au total</div></div>
    <div class="kpi" style="--i:3;--kpi-color:#22c55e"><div class="label">${icon('clock')} Temps de réponse</div><div class="value">${s.avg_ms_24h} ms</div>
      <div class="sub">moyenne 24 h</div></div>
    <div class="kpi" style="--i:4;--kpi-color:#ef4444"><div class="label">${icon('alert')} Erreurs 5xx 24 h</div><div class="value" data-count="${s.errors_24h}"></div>
      <div class="sub">${fmtNumber(s.client_errors_24h)} erreurs 4xx</div></div>
  </div>`;
}

function hourlyChart(hourly) {
  return barChart(
    hourly.map((h) => {
      const d = new Date(h.hour);
      const label = `${String(d.getHours()).padStart(2, '0')}h`;
      return { value: h.requests, error: h.s5xx, label, tooltip: `${label} : ${fmtNumber(h.requests)} requêtes, ${fmtNumber(h.s5xx)} erreurs 5xx` };
    }),
    { labelEvery: 3 }
  );
}

// --- Tabs -----------------------------------------------------------------------

async function overviewTab(ctx, site, data) {
  const { hourly } = await get(`/sites/${site.slug}/stats`);
  return {
    tpl: html`<div class="grid grid-2">
      <div class="stack">
        <div id="live"></div>
        <div class="card"><h3>${icon('upload')} ${site.current_deployment_id ? 'Mettre à jour le site' : 'Mettre en ligne'}</h3>
          ${dropzone({ compact: true, title: site.current_deployment_id ? 'Déposez la nouvelle version (.zip)' : 'Déposez votre archive .zip' })}
          <div data-progress></div>
        </div>
        <div class="card"><div class="card-head"><h3>${icon('chart')} Trafic des dernières 24 h</h3>
          <a class="small" href="#/sites/${site.slug}/stats">Détails →</a></div>
          ${hourlyChart(hourly)}
          <div class="legend"><span><i style="background:#818cf8"></i>Requêtes</span><span><i style="background:#ef4444"></i>Erreurs 5xx</span></div>
        </div>
      </div>
      <div class="stack">
        <div id="tech">${techCard(site, data.runtime)}</div>
        <div id="res">${resourcesCard(site, data.runtime)}</div>
      </div>
    </div>`,
    after: (root, reload) => {
      bindUpload(ctx, root, site, reload);
      ctx.every(10000, async () => {
        const fresh = await get(`/sites/${site.slug}`).catch(() => null);
        if (!fresh || !ctx.alive()) return;
        mount($('#tech', root), techCard(fresh.site, fresh.runtime));
        mount($('#res', root), resourcesCard(fresh.site, fresh.runtime));
      });
    },
  };
}

function bindUpload(ctx, root, site, reload) {
  bindDropzone($('.dropzone', root), async (file) => {
    try {
      const dep = await uploadZip(site.slug, file, $('[data-progress]', root));
      attachLive(ctx, root, site, dep, reload);
    } catch (err) {
      toast('error', 'Envoi impossible', err.message);
    }
  });
}

let liveCleanup = null;

function attachLive(ctx, root, site, dep, reload) {
  const box = $('#live', root);
  if (!box) return;
  if (liveCleanup) liveCleanup();
  liveCleanup = liveDeployment(box, site.slug, dep, { onDone: () => setTimeout(() => ctx.alive() && reload(), 1200) });
  ctx.cleanup(() => liveCleanup && liveCleanup());
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function deploymentsTab(ctx, site) {
  const { deployments, rollback_images: images } = await get(`/sites/${site.slug}/deployments`);
  const canRollback = (d) => d.status === 'success' && d.image && images.includes(d.image) && d.id !== site.current_deployment_id;
  return {
    tpl: html`<div class="stack">
      <div id="live"></div>
      <div class="card"><h3>${icon('upload')} Nouvelle version</h3>${dropzone({ compact: true })}<div data-progress></div></div>
      <div class="card"><h3>${icon('list')} Historique <span class="muted">(${deployments.length})</span></h3>
        ${deployments.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr>
              <th>#</th><th>Type</th><th>Statut</th><th>Par</th><th>Archive</th><th>Date</th><th>Durée</th><th></th></tr></thead>
              <tbody>${deployments.map(
                (d) => html`<tr>
                  <td class="mono">#${d.id}${d.id === site.current_deployment_id ? html` <span class="badge success" title="Version en ligne">en ligne</span>` : ''}</td>
                  <td>${d.kind_label}</td>
                  <td>${badge(d.status)}</td>
                  <td>${d.username || '—'} <span class="dim small">${d.source === 'api' ? 'API' : ''}</span></td>
                  <td class="small">${d.zip_name ? html`<span class="mono">${d.zip_name}</span> <span class="dim">${fmtBytes(d.zip_size)}</span>` : '—'}</td>
                  <td class="nowrap small">${fmtDate(d.created_at)}</td>
                  <td class="nowrap">${deploymentDuration(d)}</td>
                  <td class="actions">
                    <button class="btn sm" data-log="${d.id}">${icon('terminal')} Journal</button>
                    ${canRollback(d) ? html`<button class="btn sm" data-rollback="${d.id}">${icon('rollback')} Restaurer</button>` : ''}
                  </td></tr>`
              )}</tbody></table></div>`
          : html`<p class="muted">Aucun déploiement pour l'instant.</p>`}
      </div>
    </div>`,
    after: (root, reload) => {
      bindUpload(ctx, root, site, reload);
      const active = deployments.find((d) => d.status === 'queued' || d.status === 'running');
      if (active) attachLive(ctx, root, site, active, reload);
      $$('[data-log]', root).forEach((b) =>
        b.addEventListener('click', async () => {
          const { deployment: d } = await get(`/sites/${site.slug}/deployments/${b.dataset.log}`);
          modal({
            title: `Déploiement #${d.id} — ${d.kind_label}`,
            wide: true,
            body: html`${d.error ? html`<div class="alert error">${icon('alert')}<div>${d.error}</div></div>` : ''}
              <div class="terminal tall">${renderLog(d.log || '(journal vide)')}</div>`,
          });
        })
      );
      $$('[data-rollback]', root).forEach((b) =>
        b.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: `Restaurer la version #${b.dataset.rollback} ?`,
            text: "Le site sera remis dans l'état de cette version (même image). La version actuelle reste disponible dans l'historique.",
            confirmLabel: 'Restaurer',
          });
          if (!ok) return;
          await withButton(b, async () => {
            const { deployment } = await post(`/sites/${site.slug}/deployments/${b.dataset.rollback}/rollback`);
            attachLive(ctx, root, site, deployment, reload);
          });
        })
      );
    },
  };
}

async function logsTab(ctx, site) {
  return {
    tpl: html`<div class="card">
      <div class="card-head"><h3>${icon('terminal')} Journal de l'application</h3>
        <div class="row">
          <select class="input" id="tail" style="width:auto"><option value="100">100 lignes</option><option value="300" selected>300 lignes</option><option value="1000">1000 lignes</option></select>
          <label class="switch"><input type="checkbox" id="follow" checked><span class="track"></span><span class="small muted">Suivi auto</span></label>
          <button class="btn sm" id="refresh-logs">${icon('refresh')} Actualiser</button>
        </div>
      </div>
      <div class="terminal tall" id="logs">Chargement…</div>
    </div>`,
    after: (root) => {
      const term = $('#logs', root);
      const load = async () => {
        const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
        const { logs } = await get(`/sites/${site.slug}/logs?tail=${$('#tail', root).value}`).catch((e) => ({ logs: `Erreur : ${e.message}` }));
        if (!ctx.alive()) return;
        term.textContent = logs || (site.container_id ? '(aucune sortie pour le moment)' : "Le site n'a pas encore été déployé.");
        if (atBottom) term.scrollTop = term.scrollHeight;
      };
      load().then(() => (term.scrollTop = term.scrollHeight));
      $('#refresh-logs', root).addEventListener('click', load);
      $('#tail', root).addEventListener('change', load);
      ctx.every(4000, () => $('#follow', root).checked && load());
    },
  };
}

async function statsTab(ctx, site) {
  const st = await get(`/sites/${site.slug}/stats`);
  const s = st.summary;
  const daily = barChart(
    st.daily.map((d) => {
      const label = new Date(d.day + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      return { value: d.requests, label, tooltip: `${label} : ${fmtNumber(d.requests)} requêtes, ${fmtNumber(d.visitors)} visiteurs` };
    }),
    { line: st.daily.map((d) => d.visitors) }
  );
  const codeClass = (c) => `status-code s${String(c)[0]}`;
  return {
    tpl: html`${statsKpis(s)}
      <div class="grid grid-2">
        <div class="card"><h3>${icon('chart')} Requêtes par heure (24 h)</h3>${hourlyChart(st.hourly)}
          <div class="legend"><span><i style="background:#818cf8"></i>Requêtes</span><span><i style="background:#ef4444"></i>Erreurs 5xx</span></div></div>
        <div class="card"><h3>${icon('activity')} 14 derniers jours</h3>${daily}
          <div class="legend"><span><i style="background:#818cf8"></i>Requêtes</span><span><i style="background:#22d3ee"></i>Visiteurs uniques</span></div></div>
      </div>
      <div class="card mt"><h3>${icon('shield')} Codes de réponse (24 h)</h3>${statusBar(s.status_24h)}</div>
      <div class="card mt"><div class="card-head"><h3>${icon('eye')} Derniers accès</h3><span class="small dim">en direct, depuis le dernier démarrage d'EZDocker</span></div>
        ${st.recent.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Quand</th><th>IP</th><th>Requête</th><th>Statut</th><th>Durée</th><th>Taille</th></tr></thead>
            <tbody>${st.recent.map(
              (r) => html`<tr><td class="nowrap small">${timeAgo(r.at)}</td><td class="mono small">${r.ip}</td>
                <td class="mono small ellipsis" style="max-width:420px" title="${r.ua}"><b>${r.method}</b> ${r.path}</td>
                <td><span class="${codeClass(r.status)}">${r.status}</span></td><td class="small">${r.ms} ms</td><td class="small">${fmtBytes(r.bytes)}</td></tr>`
            )}</tbody></table></div>`
          : html`<p class="muted" style="margin:0">Aucun accès enregistré pour l'instant.</p>`}
      </div>`,
  };
}

function envRow(k = '', v = '') {
  return html`<div class="env-row"><input class="input" data-env-key placeholder="NOM_VARIABLE" value="${k}">
    <input class="input" data-env-value placeholder="valeur" value="${v}">
    <button class="btn ghost icon" type="button" data-env-del title="Supprimer">${icon('trash')}</button></div>`;
}

async function settingsTab(ctx, site, data, me) {
  const owner = me;
  return {
    tpl: html`<div class="grid grid-2">
      <form class="card" id="settings-form"><h3>${icon('sliders')} Configuration</h3>
        <div class="field"><label>Nom du site</label><input class="input" name="name" value="${site.name}" maxlength="60" required></div>
        <div class="form-grid">
          <div class="field"><label>Port de l'application dans le conteneur</label>
            <input class="input" name="container_port" type="number" min="1" max="65535" value="${site.container_port ?? ''}"
              placeholder="${site.detected_port ? `auto (${site.detected_port})` : 'auto (EXPOSE ou 80)'}">
            <span class="hint">Laissez vide pour utiliser EXPOSE du Dockerfile.</span></div>
          <div class="field"><label>Mémoire max (Mo)</label>
            <input class="input" name="memory_mb" type="number" min="32" max="${owner ? owner.max_memory_mb : 65536}" value="${site.memory_mb}">
            ${owner ? html`<span class="hint">Maximum autorisé : ${owner.max_memory_mb} Mo</span>` : ''}</div>
          <div class="field"><label>CPU max</label>
            <input class="input" name="cpus" type="number" min="0.1" step="0.1" max="${owner ? owner.max_cpus : 64}" value="${site.cpus}">
            ${owner ? html`<span class="hint">Maximum autorisé : ${owner.max_cpus}</span>` : ''}</div>
        </div>
        <div class="field"><label>Variables d'environnement</label>
          <div id="env">${Object.entries(site.env).map(([k, v]) => envRow(k, v))}</div>
          <div><button class="btn sm" type="button" id="add-env">${icon('plus')} Ajouter une variable</button></div>
          <span class="hint">La variable PORT est fournie automatiquement. Les changements redémarrent le conteneur.</span>
        </div>
        <button class="btn primary" type="submit">${icon('check')} Enregistrer</button>
      </form>
      <div class="stack">
        <div class="card"><h3>${icon('code')} Mettre à jour via l'API</h3>
          <p class="muted small" style="margin-top:0">Créez un jeton dans <a href="#/account">Mon compte</a>, puis :</p>
          <div class="code-block"><pre>curl -H "Authorization: Bearer VOTRE_JETON" \\
     -F file=@site.zip \\
     ${location.origin}/api/sites/${site.slug}/deploy</pre>${copyBtn(`curl -H "Authorization: Bearer VOTRE_JETON" -F file=@site.zip ${location.origin}/api/sites/${site.slug}/deploy`)}</div>
        </div>
        <div class="card" style="border-color:rgba(239,68,68,.3)"><h3 style="color:#fca5a5">${icon('alert')} Zone dangereuse</h3>
          <p class="muted small" style="margin-top:0">Supprime le conteneur, les images, les archives et les statistiques. Le port ${site.public_port} sera libéré.</p>
          <button class="btn danger" id="delete-site">${icon('trash')} Supprimer le site</button>
        </div>
      </div>
    </div>`,
    after: (root, reload) => {
      const env = $('#env', root);
      env.addEventListener('click', (e) => {
        const b = e.target.closest('[data-env-del]');
        if (b) b.closest('.env-row').remove();
      });
      $('#add-env', root).addEventListener('click', () => {
        env.insertAdjacentHTML('beforeend', envRow().toString());
        env.lastElementChild.querySelector('input').focus();
      });
      const form = $('#settings-form', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const envObj = {};
        for (const row of $$('.env-row', env)) {
          const k = row.querySelector('[data-env-key]').value.trim();
          if (k) envObj[k] = row.querySelector('[data-env-value]').value;
        }
        await withButton(form.querySelector('[type=submit]'), async () => {
          const res = await patch(`/sites/${site.slug}`, {
            name: form.name.value,
            container_port: form.container_port.value === '' ? null : Number(form.container_port.value),
            memory_mb: Number(form.memory_mb.value),
            cpus: Number(form.cpus.value),
            env: envObj,
          });
          toast('success', 'Paramètres enregistrés', res.deployment ? 'Application de la nouvelle configuration…' : '');
          if (res.deployment) navigate(`/sites/${site.slug}/deployments`);
          else reload();
        }).catch(() => {});
      });
      $('#delete-site', root).addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Supprimer « ${site.name} » ?`,
          text: 'Cette action est définitive : conteneur, images, statistiques et données persistantes du site (volumes) seront effacés.',
          confirmLabel: 'Supprimer définitivement',
          danger: true,
          typeToConfirm: site.slug,
        });
        if (!ok) return;
        await del(`/sites/${site.slug}`);
        toast('success', 'Site supprimé');
        navigate('/');
      });
    },
  };
}

const TAB_VIEWS = { overview: overviewTab, deployments: deploymentsTab, logs: logsTab, stats: statsTab, settings: settingsTab };

export async function siteView(ctx) {
  const [slug, tabParam] = ctx.params;
  const tab = TAB_VIEWS[tabParam] ? tabParam : 'overview';
  let me = null;

  const render = async () => {
    const data = await get(`/sites/${slug}`);
    if (!me && tab === 'settings') {
      me = isAdmin() && data.site.owner_id ? (await get('/admin/users')).users.find((u) => u.id === data.site.owner_id) : (await get('/auth/me')).user;
      if (me && me.role === 'superadmin') me = null;
    }
    const view = await TAB_VIEWS[tab](ctx, data.site, data, me);
    if (!ctx.alive()) return;
    mount(ctx.el, html`<div class="page">${header(data.site, data.runtime, data.busy)}<div id="tab">${view.tpl}</div></div>`);
    $$('[data-tab]', ctx.el).forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    bindHeader(data.site);
    view.after && view.after(ctx.el, render);

    if (tab === 'overview') {
      const { deployments } = await get(`/sites/${slug}/deployments`);
      const active = deployments.find((d) => d.status === 'queued' || d.status === 'running');
      if (active && ctx.alive()) attachLive(ctx, ctx.el, data.site, active, render);
    }
  };
  ctx.rerender = render;

  const bindHeader = (site) => {
    $$('[data-act]', ctx.el).forEach((b) =>
      b.addEventListener('click', async () => {
        const act = b.dataset.act;
        if (act === 'stop') {
          const ok = await confirmDialog({ title: 'Arrêter le site ?', text: 'Les visiteurs verront une page « Site arrêté » jusqu’au redémarrage.', confirmLabel: 'Arrêter' });
          if (!ok) return;
        }
        await withButton(b, async () => {
          const res = await post(`/sites/${site.slug}/${act}`);
          if (act === 'rebuild') {
            toast('info', 'Reconstruction lancée');
            return navigate(`/sites/${site.slug}/deployments`);
          }
          toast('success', { start: 'Site démarré', stop: 'Site arrêté', restart: 'Site redémarré' }[act]);
          if (res) render();
        }).catch(() => {});
      })
    );
  };

  await render();

  ctx.live(async ({ kind, data }) => {
    if (kind !== 'site' || data.id === undefined) return;
    const current = await get(`/sites/${slug}`).catch(() => null);
    if (!current) {
      if (data.deleted) navigate('/');
      return;
    }
    if (data.id !== current.site.id || !ctx.alive()) return;
    // Refresh header only (keeps live terminal and forms intact).
    const head = ctx.el.querySelector('.page');
    const tabEl = $('#tab', ctx.el);
    if (!head || !tabEl) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = header(current.site, current.runtime, current.busy).toString();
    [...head.children].forEach((c) => c !== tabEl && c.remove());
    head.prepend(...tmp.children);
    $$('[data-tab]', ctx.el).forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    bindHeader(current.site);
    const tech = $('#tech', ctx.el);
    if (tech) mount(tech, techCard(current.site, current.runtime));
  });
}

