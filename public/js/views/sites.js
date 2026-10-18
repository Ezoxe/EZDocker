import { get, post } from '../api.js';
import { html, raw, mount, icon, badge, modal, toast, fmtNumber, fmtBytes, timeAgo, $, formData } from '../ui.js';
import { sparkline } from '../charts.js';
import { state, isAdmin, navigate } from '../app.js';
import { dropzone, bindDropzone, uploadZip } from './deploy.js';

function slugify(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

function siteCard(s, i) {
  const color = s.status === 'error' ? '#ef4444' : s.status === 'stopped' ? '#f59e0b' : '#818cf8';
  return html`<a class="site-card" href="#/sites/${s.slug}" style="--i:${i}">
    <div class="top">
      <div style="min-width:0">
        <h3 class="ellipsis">${s.name}</h3>
        <span class="url">${s.host}:${s.public_port}</span>
      </div>
      ${badge(s.status)}
    </div>
    <div class="spark">${sparkline(s.stats.sparkline, { color })}</div>
    <div class="meta">
      <span><b>${fmtNumber(s.stats.requests_24h)}</b> requêtes 24h</span>
      <span><b>${fmtNumber(s.stats.visitors_24h)}</b> visiteurs</span>
      <span>${icon('clock', 'dim')} ${s.last_deployed_at ? timeAgo(s.last_deployed_at) : 'jamais déployé'}</span>
    </div>
    ${isAdmin() ? html`<div class="owner">${icon('user')} ${s.owner}</div>` : ''}
  </a>`;
}

export async function sitesView(ctx) {
  const render = (sites) => {
    const online = sites.filter((s) => s.status === 'running').length;
    const req = sites.reduce((a, s) => a + s.stats.requests_24h, 0);
    const vis = sites.reduce((a, s) => a + s.stats.visitors_24h, 0);
    const bw = sites.reduce((a, s) => a + s.stats.bytes_out_24h, 0);
    const limit = isAdmin() ? null : state.user.max_sites;
    mount(
      ctx.el,
      html`<div class="page">
        <div class="page-head">
          <div><h1>${isAdmin() ? 'Tous les sites' : 'Mes sites'}</h1>
            <p>Déposez un .zip contenant un Dockerfile : EZDocker s'occupe du reste.</p></div>
          <div class="actions">
            <a class="btn" href="/api/example.zip" download>${icon('download')} Exemple .zip</a>
            <button class="btn primary" id="new-site" ${limit !== null && sites.length >= limit ? raw('disabled title="Limite atteinte"') : ''}>${icon('plus')} Nouveau site</button>
          </div>
        </div>
        <div class="kpis stagger">
          <div class="kpi" style="--i:0;--kpi-color:#22c55e"><div class="label">${icon('globe')} En ligne</div>
            <div class="value"><span data-count="${online}"></span><span class="dim" style="font-size:1rem"> / ${sites.length}${limit !== null ? ` (max ${limit})` : ''}</span></div></div>
          <div class="kpi" style="--i:1"><div class="label">${icon('activity')} Requêtes 24 h</div><div class="value" data-count="${req}"></div></div>
          <div class="kpi" style="--i:2;--kpi-color:#22d3ee"><div class="label">${icon('users')} Visiteurs 24 h</div><div class="value" data-count="${vis}"></div></div>
          <div class="kpi" style="--i:3;--kpi-color:#f472b6"><div class="label">${icon('zap')} Bande passante 24 h</div><div class="value" data-count="${bw}" data-format="bytes"></div></div>
        </div>
        ${sites.length
          ? html`<div class="grid grid-auto stagger">${sites.map(siteCard)}</div>`
          : html`<div class="card empty">
              <div class="illu">${icon('box')}</div>
              <h3>Aucun site pour le moment</h3>
              <p>Créez votre premier site puis glissez une archive .zip contenant votre code et un Dockerfile. Il sera en ligne en quelques secondes.</p>
              <div class="row" style="justify-content:center">
                <button class="btn primary" id="new-site-empty">${icon('plus')} Créer mon premier site</button>
                <a class="btn" href="/api/example.zip" download>${icon('download')} Télécharger un exemple</a>
              </div>
            </div>`}
      </div>`
    );
    for (const id of ['#new-site', '#new-site-empty']) $(id, ctx.el)?.addEventListener('click', () => newSiteModal());
  };

  const load = async () => {
    const { sites } = await get('/sites');
    if (ctx.alive()) render(sites);
  };
  await load();
  ctx.live(load);
  ctx.every(30000, load);
}

export async function newSiteModal() {
  let file = null;
  let slugTouched = false;
  const users = isAdmin() ? (await get('/admin/users')).users : [];

  modal({
    title: 'Nouveau site',
    wide: true,
    body: html`<form id="new-site-form">
      <div class="form-grid">
        <div class="field"><label>Nom du site</label><input class="input" name="name" placeholder="Mon portfolio" required maxlength="60"></div>
        <div class="field"><label>Identifiant</label><input class="input mono" name="slug" placeholder="mon-portfolio" maxlength="32">
          <span class="hint">Utilisé pour l'API et le nom du conteneur.</span></div>
        ${isAdmin()
          ? html`<div class="field full"><label>Propriétaire</label><select class="input" name="owner_id">
              ${users.map((u) => html`<option value="${u.id}" ${u.id === state.user.id ? 'selected' : ''}>${u.username}${u.role === 'superadmin' ? ' (vous)' : ''}</option>`)}
            </select></div>`
          : ''}
      </div>
      <div class="field"><label>Archive (optionnel, vous pourrez la déposer plus tard)</label>
        ${dropzone({ compact: true })}
        <div data-file></div><div data-progress></div>
      </div>
      <p class="small dim" style="margin:0">${icon('info')} Un port public sera attribué automatiquement.</p>
    </form>`,
    actions: [
      { label: 'Annuler', class: 'ghost' },
      {
        label: 'Créer le site',
        class: 'primary',
        icon: 'rocket',
        onClick: async ({ el }) => {
          const data = formData(el.querySelector('form'));
          if (!data.name.trim()) throw new Error('Donnez un nom à votre site.');
          const body = { name: data.name, slug: data.slug || undefined };
          if (data.owner_id) body.owner_id = Number(data.owner_id);
          const { site } = await post('/sites', body);
          if (file) {
            await uploadZip(site.slug, file, el.querySelector('[data-progress]'));
          }
          toast('success', 'Site créé', `Port attribué : ${site.public_port}`);
          navigate(`/sites/${site.slug}`);
        },
      },
    ],
    onMount: ({ el }) => {
      const name = el.querySelector('[name=name]');
      const slug = el.querySelector('[name=slug]');
      name.addEventListener('input', () => {
        if (!slugTouched) slug.value = slugify(name.value);
      });
      slug.addEventListener('input', () => {
        slugTouched = true;
        slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      });
      bindDropzone(el.querySelector('.dropzone'), (f) => {
        file = f;
        mount(el.querySelector('[data-file]'), html`<div class="file-pill">${icon('archive')} ${f.name} · ${fmtBytes(f.size)}</div>`);
      });
    },
  });
}
