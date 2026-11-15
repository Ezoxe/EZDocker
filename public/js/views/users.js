import { get, post, patch, del } from '../api.js';
import { html, mount, icon, modal, toast, confirmDialog, secretModal, timeAgo, formData, $$ } from '../ui.js';
import { state } from '../app.js';

function limitsFields(u = {}, defaults = {}) {
  return html`<div class="form-grid">
    <div class="field"><label>Sites max</label><input class="input" type="number" name="max_sites" min="0" max="1000" value="${u.max_sites ?? defaults.default_max_sites}"></div>
    <div class="field"><label>RAM max par site (Mo)</label><input class="input" type="number" name="max_memory_mb" min="32" max="65536" value="${u.max_memory_mb ?? defaults.default_memory_mb}"></div>
    <div class="field"><label>CPU max par site</label><input class="input" type="number" name="max_cpus" min="0.1" max="64" step="0.1" value="${u.max_cpus ?? defaults.default_cpus}"></div>
  </div>`;
}

export async function usersView(ctx) {
  const { settings } = await get('/admin/settings');

  const render = async () => {
    const { users } = await get('/admin/users');
    if (!ctx.alive()) return;
    mount(
      ctx.el,
      html`<div class="page">
        <div class="page-head"><div><h1>Utilisateurs</h1><p>Seuls les comptes créés ici peuvent déposer des sites.</p></div>
          <div class="actions"><button class="btn primary" id="new-user">${icon('plus')} Nouvel utilisateur</button></div></div>
        <div class="card">
          <div class="table-wrap"><table class="table"><thead><tr><th>Utilisateur</th><th>Sites</th><th>Limites / site</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead>
          <tbody class="stagger">${users.map(
            (u, i) => html`<tr style="--i:${i}">
              <td><div class="row" style="gap:12px;flex-wrap:nowrap"><div class="avatar">${u.username.slice(0, 2)}</div>
                <div><b>${u.username}</b> ${u.role === 'superadmin' ? html`<span class="badge role">super admin</span>` : ''}<div class="dim small">${u.email || '—'}</div></div></div></td>
              <td>${u.sites_count}${u.role === 'superadmin' ? '' : html` <span class="dim">/ ${u.max_sites}</span>`}</td>
              <td class="small muted">${u.role === 'superadmin' ? 'illimité' : `${u.max_memory_mb} Mo · ${u.max_cpus} CPU`}</td>
              <td>${u.disabled ? html`<span class="badge error"><span class="dot"></span>Désactivé</span>` : u.must_change_password ? html`<span class="badge stopped"><span class="dot"></span>Mot de passe à changer</span>` : html`<span class="badge success"><span class="dot"></span>Actif</span>`}</td>
              <td class="small">${u.last_login_at ? timeAgo(u.last_login_at) : 'jamais'}</td>
              <td class="actions">
                ${u.role !== 'superadmin'
                  ? html`<button class="btn sm" data-edit="${u.id}" title="Modifier">${icon('pencil')}</button>
                    <button class="btn sm" data-reset="${u.id}" title="Réinitialiser le mot de passe">${icon('key')}</button>
                    <button class="btn sm" data-toggle="${u.id}" title="${u.disabled ? 'Réactiver' : 'Désactiver'}">${icon(u.disabled ? 'play' : 'ban')}</button>
                    <button class="btn sm danger" data-delete="${u.id}" title="Supprimer">${icon('trash')}</button>`
                  : html`<button class="btn sm" data-reset="${u.id}" title="Changer mon mot de passe">${icon('key')}</button>`}
              </td></tr>`
          )}</tbody></table></div>
        </div>
      </div>`
    );

    const byId = (id) => users.find((u) => u.id === Number(id));

    $$('#new-user', ctx.el).forEach((b) =>
      b.addEventListener('click', () =>
        modal({
          title: 'Nouvel utilisateur',
          body: html`<form><div class="form-grid">
              <div class="field"><label>Identifiant</label><input class="input" name="username" required placeholder="jdupont" pattern="[a-zA-Z0-9._-]{3,32}"></div>
              <div class="field"><label>E-mail (optionnel)</label><input class="input" name="email" type="email" placeholder="jean@exemple.fr"></div>
              <div class="field full"><label>Mot de passe</label><input class="input" name="password" type="text" placeholder="Laisser vide pour en générer un">
                <span class="hint">L'utilisateur devra le changer à sa première connexion.</span></div>
            </div>${limitsFields({}, settings)}</form>`,
          actions: [
            { label: 'Annuler', class: 'ghost' },
            {
              label: 'Créer le compte',
              class: 'primary',
              onClick: async ({ el }) => {
                const data = formData(el.querySelector('form'));
                if (!data.password) delete data.password;
                const res = await post('/admin/users', data);
                render();
                setTimeout(
                  () => secretModal(`Compte « ${res.user.username} » créé`, 'Transmettez ces identifiants à l’utilisateur. Le mot de passe ne sera plus affiché.', `${res.user.username} / ${res.password}`),
                  220
                );
              },
            },
          ],
        })
      )
    );

    $$('[data-edit]', ctx.el).forEach((b) =>
      b.addEventListener('click', () => {
        const u = byId(b.dataset.edit);
        modal({
          title: `Modifier ${u.username}`,
          body: html`<form><div class="field"><label>E-mail</label><input class="input" name="email" type="email" value="${u.email}"></div>${limitsFields(u)}
            <p class="small dim" style="margin:0">Les limites s'appliquent aux nouveaux réglages des sites de l'utilisateur.</p></form>`,
          actions: [
            { label: 'Annuler', class: 'ghost' },
            {
              label: 'Enregistrer',
              class: 'primary',
              onClick: async ({ el }) => {
                await patch(`/admin/users/${u.id}`, formData(el.querySelector('form')));
                toast('success', 'Utilisateur mis à jour');
                render();
              },
            },
          ],
        });
      })
    );

    $$('[data-reset]', ctx.el).forEach((b) =>
      b.addEventListener('click', async () => {
        const u = byId(b.dataset.reset);
        const self = u.id === state.user.id;
        const ok = await confirmDialog({
          title: `Nouveau mot de passe pour ${u.username} ?`,
          text: self ? 'Un nouveau mot de passe va être généré pour votre compte. Vous serez déconnecté.' : 'Un mot de passe temporaire va être généré et ses sessions seront fermées.',
          confirmLabel: 'Générer',
        });
        if (!ok) return;
        const { password } = await post(`/admin/users/${u.id}/reset-password`);
        secretModal('Nouveau mot de passe', `Identifiants de ${u.username} :`, `${u.username} / ${password}`);
        if (!self) render();
      })
    );

    $$('[data-toggle]', ctx.el).forEach((b) =>
      b.addEventListener('click', async () => {
        const u = byId(b.dataset.toggle);
        await patch(`/admin/users/${u.id}`, { disabled: !u.disabled });
        toast('success', u.disabled ? 'Compte réactivé' : 'Compte désactivé', u.disabled ? '' : 'Ses sites restent en ligne.');
        render();
      })
    );

    $$('[data-delete]', ctx.el).forEach((b) =>
      b.addEventListener('click', async () => {
        const u = byId(b.dataset.delete);
        const ok = await confirmDialog({
          title: `Supprimer ${u.username} ?`,
          text: `Ses ${u.sites_count} site(s) seront aussi supprimés définitivement (conteneurs, images, statistiques, données persistantes).`,
          confirmLabel: 'Supprimer',
          danger: true,
          typeToConfirm: u.username,
        });
        if (!ok) return;
        await del(`/admin/users/${u.id}`);
        toast('success', 'Utilisateur supprimé');
        render();
      })
    );
  };
  await render();
}
