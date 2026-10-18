import { get } from '../api.js';
import { html, mount, icon, badge, fmtNumber, fmtBytes, fmtDuration, timeAgo, fmtDate, $ } from '../ui.js';
import { barChart } from '../charts.js';

const EVENT_STYLE = {
  'site.deployed': ['good', 'rocket'],
  'site.updated': ['good', 'refresh'],
  'site.deploy_failed': ['bad', 'alert'],
  'site.crashed': ['bad', 'alert'],
  'site.started': ['good', 'play'],
  'site.stopped': ['', 'stop'],
  'site.deleted': ['', 'trash'],
  'site.created': ['info', 'plus'],
  'deployment.started': ['info', 'hammer'],
};

export function eventItem(e, i = 0) {
  const [cls, ic] = EVENT_STYLE[e.event] || ['', 'info'];
  return html`<div class="ev" style="animation-delay:${i * 30}ms"><div class="ico ${cls}">${icon(ic)}</div>
    <div class="txt"><b>${e.label}</b> — ${e.message}
      <small>${timeAgo(e.timestamp)}${e.actor ? ` · par ${e.actor.username}` : ''}${e.site ? html` · <a href="#/sites/${e.site.slug}">${e.site.name}</a>` : ''}</small></div></div>`;
}

function meter(label, used, total, fmt = fmtBytes) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return html`<div class="field"><div class="row between small"><span class="muted">${label}</span><span class="mono">${fmt(used)} / ${fmt(total)} (${pct.toFixed(0)} %)</span></div>
    <div class="meter ${pct > 85 ? 'warn' : ''}"><span style="width:${pct}%"></span></div></div>`;
}

export async function overviewView(ctx) {
  const render = async () => {
    const [o, ev] = await Promise.all([get('/admin/overview'), get('/events?limit=12')]);
    if (!ctx.alive()) return;
    const h = o.host;
    const d = o.docker || {};
    const t = o.traffic.summary;
    mount(
      ctx.el,
      html`<div class="page">
        <div class="page-head"><div><h1>Vue globale</h1><p>État de la plateforme et de la machine ${h.hostname}.</p></div>
          <div class="actions"><a class="btn" href="#/admin/users">${icon('users')} Utilisateurs</a></div></div>
        <div class="kpis stagger">
          <div class="kpi" style="--i:0"><div class="label">${icon('users')} Utilisateurs</div><div class="value" data-count="${o.counts.users}"></div></div>
          <div class="kpi" style="--i:1;--kpi-color:#22c55e"><div class="label">${icon('globe')} Sites en ligne</div>
            <div class="value"><span data-count="${o.counts.running}"></span><span class="dim" style="font-size:1rem"> / ${o.counts.sites}</span></div>
            <div class="sub">${o.counts.errors} en erreur</div></div>
          <div class="kpi" style="--i:2;--kpi-color:#a78bfa"><div class="label">${icon('rocket')} Déploiements 24 h</div><div class="value" data-count="${o.counts.deployments_24h}"></div>
            <div class="sub">${o.counts.failed_24h} échec(s)</div></div>
          <div class="kpi" style="--i:3;--kpi-color:#22d3ee"><div class="label">${icon('activity')} Requêtes 24 h</div><div class="value" data-count="${t.requests_24h}"></div>
            <div class="sub">${fmtNumber(t.visitors_24h)} visiteurs uniques</div></div>
          <div class="kpi" style="--i:4;--kpi-color:#f472b6"><div class="label">${icon('zap')} Bande passante 24 h</div><div class="value" data-count="${t.bytes_out_24h}" data-format="bytes"></div></div>
        </div>
        <div class="grid grid-3 stagger">
          <div class="card" style="--i:0"><h3>${icon('server')} Machine</h3>
            <div class="info" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
              <div class="item"><span class="k">IP publique</span><span class="v">${h.public_host}</span></div>
              <div class="item"><span class="k">IP détectée</span><span class="v">${h.detected_ip}</span></div>
              <div class="item"><span class="k">Système</span><span class="v" title="${h.platform}">${h.platform}</span></div>
              <div class="item"><span class="k">Uptime</span><span class="v">${fmtDuration(h.uptime * 1000)}</span></div>
            </div>
            <div class="field"><div class="row between small"><span class="muted">CPU (${h.cpus} cœurs)</span><span class="mono">${h.cpu_percent ?? '…'} % · charge ${h.load.map((l) => l.toFixed(2)).join(' ')}</span></div>
              <div class="meter ${h.cpu_percent > 85 ? 'warn' : ''}"><span style="width:${h.cpu_percent || 0}%"></span></div></div>
            ${meter('Mémoire', h.memory.total - h.memory.free, h.memory.total)}
            ${h.disk ? meter('Disque (données)', h.disk.total - h.disk.free, h.disk.total) : ''}
          </div>
          <div class="card" style="--i:1"><h3>${icon('box')} Docker</h3>
            ${d.error
              ? html`<div class="alert error">${icon('alert')}<div>Docker injoignable : ${d.error}</div></div>`
              : html`<div class="info">
                  <div class="item"><span class="k">Version</span><span class="v">${d.version}</span></div>
                  <div class="item"><span class="k">API</span><span class="v">${d.api_version}</span></div>
                  <div class="item"><span class="k">Conteneurs</span><span class="v">${d.containers_running} / ${d.containers} actifs</span></div>
                  <div class="item"><span class="k">Images</span><span class="v">${d.images}</span></div>
                  <div class="item"><span class="k">OS</span><span class="v" title="${d.os}">${d.os}</span></div>
                  <div class="item"><span class="k">EZDocker</span><span class="v">v${h.ezdocker_version} · ${h.node}</span></div>
                </div>`}
          </div>
          <div class="card" style="--i:2"><div class="card-head"><h3>${icon('list')} Activité récente</h3><a class="small" href="#/admin/events">Tout voir →</a></div>
            <div class="feed">${ev.events.length ? ev.events.slice(0, 6).map(eventItem) : html`<p class="muted small">Rien pour le moment.</p>`}</div>
          </div>
        </div>
        <div class="card mt"><h3>${icon('chart')} Trafic global (24 h)</h3>
          ${barChart(o.traffic.hourly.map((x) => {
            const dd = new Date(x.hour);
            const label = `${String(dd.getHours()).padStart(2, '0')}h`;
            return { value: x.requests, error: x.s5xx, label, tooltip: `${label} : ${fmtNumber(x.requests)} requêtes` };
          }), { labelEvery: 3 })}
        </div>
        <div class="card mt"><h3>${icon('grid')} Tous les sites <span class="muted">(${o.sites.length})</span></h3>
          ${o.sites.length
            ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Site</th><th>Propriétaire</th><th>Statut</th><th>Adresse</th><th>Requêtes 24 h</th><th>Visiteurs</th><th>Dernier déploiement</th></tr></thead>
              <tbody>${o.sites.map(
                (s) => html`<tr><td><a href="#/sites/${s.slug}"><b>${s.name}</b></a><div class="dim small mono">${s.slug}</div></td>
                  <td>${s.owner}</td><td>${badge(s.status)}</td>
                  <td class="mono small"><a href="${s.url}" target="_blank" rel="noopener">${s.host}:${s.public_port}</a></td>
                  <td>${fmtNumber(s.stats.requests_24h)}</td><td>${fmtNumber(s.stats.visitors_24h)}</td>
                  <td class="small">${s.last_deployed_at ? timeAgo(s.last_deployed_at) : '—'}</td></tr>`
              )}</tbody></table></div>`
            : html`<p class="muted">Aucun site.</p>`}
        </div>
      </div>`
    );
  };
  await render();
  ctx.live(render);
  ctx.every(20000, render);
}

export async function eventsView(ctx) {
  let events = [];
  let type = '';
  let done = false;
  const { settings } = await get('/admin/settings');

  const load = async (more = false) => {
    const before = more && events.length ? `&before=${events[events.length - 1].id.replace('evt_', '')}` : '';
    const res = await get(`/events?limit=50${type ? `&type=${type}` : ''}${before}`);
    events = more ? events.concat(res.events) : res.events;
    done = res.events.length < 50;
    if (ctx.alive()) render();
  };

  const render = () => {
    mount(
      ctx.el,
      html`<div class="page">
        <div class="page-head"><div><h1>Journal</h1><p>Tous les événements envoyés aux webhooks et e-mails.</p></div>
          <div class="actions"><select class="input" id="type" style="width:auto">
            <option value="">Tous les événements</option>
            ${settings.all_events.map((e) => html`<option value="${e}" ${e === type ? 'selected' : ''}>${settings.event_labels[e]} (${e})</option>`)}
          </select></div></div>
        <div class="card">
          ${events.length
            ? html`<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Date</th><th>Événement</th><th>Site</th><th>Message</th><th>Par</th></tr></thead>
              <tbody>${events.map(
                (e) => html`<tr><td class="mono small dim">${e.id}</td><td class="nowrap small">${fmtDate(e.timestamp)}</td>
                  <td><span class="badge ${/failed|crashed/.test(e.event) ? 'error' : /deployed|updated|started/.test(e.event) ? 'success' : ''}">${e.label}</span></td>
                  <td>${e.site ? html`<a href="#/sites/${e.site.slug}">${e.site.name}</a>` : '—'}</td>
                  <td class="small">${e.message}</td><td class="small">${e.actor ? e.actor.username : 'système'}</td></tr>`
              )}</tbody></table></div>
              ${!done ? html`<div class="row" style="justify-content:center;margin-top:14px"><button class="btn" id="more">Charger plus</button></div>` : ''}`
            : html`<p class="muted">Aucun événement.</p>`}
        </div>
      </div>`
    );
    $('#type', ctx.el).addEventListener('change', (e) => {
      type = e.target.value;
      load();
    });
    $('#more', ctx.el)?.addEventListener('click', () => load(true));
  };
  await load();
  ctx.live(({ kind }) => kind === 'activity' && load());
}
