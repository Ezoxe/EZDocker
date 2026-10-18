import { get, post, onApi } from './api.js';
import { html, mount, icon, $, $$, toast, debounce } from './ui.js';
import { showLogin, showForcePassword } from './views/auth.js';
import { sitesView } from './views/sites.js';
import { siteView } from './views/site.js';
import { accountView } from './views/account.js';
import { overviewView, eventsView } from './views/admin.js';
import { usersView } from './views/users.js';
import { settingsView, notificationsView } from './views/settings.js';

export const state = { user: null, instance: null };

const routes = [
  { re: /^\/$/, view: sitesView, nav: '/' },
  { re: /^\/sites\/([a-z0-9-]+)(?:\/(\w+))?$/, view: siteView, nav: '/' },
  { re: /^\/account$/, view: accountView, nav: '/account' },
  { re: /^\/admin$/, view: overviewView, nav: '/admin', admin: true },
  { re: /^\/admin\/users$/, view: usersView, nav: '/admin/users', admin: true },
  { re: /^\/admin\/notifications$/, view: notificationsView, nav: '/admin/notifications', admin: true },
  { re: /^\/admin\/events$/, view: eventsView, nav: '/admin/events', admin: true },
  { re: /^\/admin\/settings$/, view: settingsView, nav: '/admin/settings', admin: true },
];

let routeId = 0;
let current = { cleanups: [], live: [] };
let source = null;
let started = false;

export const isAdmin = () => state.user && state.user.role === 'superadmin';
export const navigate = (path) => {
  if (location.hash === '#' + path) route();
  else location.hash = '#' + path;
};

function navLink(path, label, iconName) {
  return html`<a class="nav-link" href="#${path}" data-nav="${path}">${icon(iconName)}<span>${label}</span></a>`;
}

function renderShell() {
  const u = state.user;
  mount(
    $('#app'),
    html`<div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="logo-mark"></div><div>${state.instance?.name || 'EZDocker'}<small>Déploiement en un glisser-déposer</small></div></div>
        ${navLink('/', isAdmin() ? 'Tous les sites' : 'Mes sites', 'grid')}
        ${navLink('/account', 'Mon compte & API', 'key')}
        ${isAdmin()
          ? html`<div class="nav-section">Administration</div>
            ${navLink('/admin', 'Vue globale', 'activity')}
            ${navLink('/admin/users', 'Utilisateurs', 'users')}
            ${navLink('/admin/notifications', 'Notifications & API', 'bell')}
            ${navLink('/admin/events', 'Journal', 'list')}
            ${navLink('/admin/settings', 'Paramètres', 'sliders')}`
          : ''}
        <div class="spacer"></div>
        <div class="user-chip">
          <div class="avatar">${u.username.slice(0, 2)}</div>
          <div class="who"><b>${u.username}</b><span>${isAdmin() ? 'Super admin' : 'Utilisateur'}</span></div>
          <button class="btn ghost icon" id="logout" title="Se déconnecter">${icon('logout')}</button>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div class="brand"><div class="logo-mark"></div>${state.instance?.name || 'EZDocker'}</div>
          <button class="btn ghost icon" id="menu">${icon('menu')}</button>
        </div>
        <div id="view"></div>
      </main>
    </div>`
  );
  $('#logout').addEventListener('click', async () => {
    await post('/auth/logout').catch(() => {});
    stopLive();
    state.user = null;
    showLogin();
  });
  $('#menu').addEventListener('click', () => $('.layout').classList.toggle('menu-open'));
}

async function route() {
  if (!state.user || !$('#view')) return;
  const path = location.hash.slice(1) || '/';
  let match = null;
  let entry = routes.find((r) => (match = r.re.exec(path)));
  if (!entry || (entry.admin && !isAdmin())) {
    entry = routes[0];
    match = [];
    if (path !== '/') history.replaceState(null, '', '#/');
  }

  for (const fn of current.cleanups) fn();
  const id = ++routeId;
  current = { cleanups: [], live: [] };

  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === entry.nav));
  $('.layout')?.classList.remove('menu-open');

  const el = $('#view');
  el.innerHTML = '<div class="page"><div class="skeleton" style="height:60px;margin-bottom:20px"></div><div class="skeleton" style="height:240px"></div></div>';
  window.scrollTo({ top: 0 });

  const ctx = {
    el,
    params: match.slice(1),
    alive: () => id === routeId,
    cleanup: (fn) => current.cleanups.push(fn),
    live: (fn) => current.live.push(debounce(fn, 400)),
    every: (ms, fn) => {
      const t = setInterval(() => {
        if (document.visibilityState === 'visible') fn();
      }, ms);
      current.cleanups.push(() => clearInterval(t));
    },
  };
  try {
    await entry.view(ctx);
  } catch (err) {
    if (!ctx.alive()) return;
    if (err.code === 'SITE_NOT_FOUND') {
      toast('error', 'Site introuvable');
      return navigate('/');
    }
    mount(el, html`<div class="page"><div class="alert error">${icon('alert')}<div><b>Impossible d'afficher la page.</b><br>${err.message}</div></div></div>`);
  }
}

const NOTIFY = {
  'site.deployed': ['success', 'Site en ligne'],
  'site.updated': ['success', 'Site mis à jour'],
  'site.deploy_failed': ['error', 'Échec du déploiement'],
  'site.crashed': ['error', 'Site planté'],
};

function startLive() {
  stopLive();
  source = new EventSource('/api/events/stream');
  const dispatch = (kind, data) => current.live.forEach((fn) => fn({ kind, data }));
  source.addEventListener('site', (e) => dispatch('site', JSON.parse(e.data)));
  source.addEventListener('activity', (e) => {
    const evt = JSON.parse(e.data);
    dispatch('activity', evt);
    const n = NOTIFY[evt.event];
    const mine = evt.actor && state.user && evt.actor.id === state.user.id;
    if (n && (!mine || evt.event === 'site.crashed')) toast(n[0], n[1], evt.message, 6000);
  });
}

function stopLive() {
  if (source) source.close();
  source = null;
}

export function startApp() {
  renderShell();
  startLive();
  if (!started) {
    started = true;
    window.addEventListener('hashchange', route);
  }
  route();
}

export async function refreshMe() {
  const me = await get('/auth/me');
  state.user = me.user;
  state.instance = me.instance;
  return me;
}

async function boot() {
  onApi('unauthorized', () => {
    if (!state.user) return;
    state.user = null;
    stopLive();
    toast('info', 'Session expirée', 'Merci de vous reconnecter.');
    showLogin();
  });
  onApi('passwordRequired', () => showForcePassword());

  let me = null;
  try {
    me = await refreshMe();
  } catch {
    /* server unreachable: show login */
  }
  if (!me || !me.user) return showLogin();
  if (me.user.must_change_password) return showForcePassword();
  startApp();
}

boot();
