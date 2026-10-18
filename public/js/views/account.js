import { get, post, del } from '../api.js';
import { html, mount, icon, toast, modal, confirmDialog, withButton, secretModal, copyBtn, fmtDate, timeAgo, $, $$ } from '../ui.js';
import { state, isAdmin } from '../app.js';

function codeBlock(text) {
  return html`<div class="code-block"><pre>${text}</pre>${copyBtn(text.replace(/\\\n\s*/g, ''))}</div>`;
}

export async function accountView(ctx) {
  const render = async () => {
    const { tokens } = await get('/account/tokens');
    if (!ctx.alive()) return;
    const u = state.user;
    const origin = location.origin;
    mount(
      ctx.el,
      html`<div class="page">
        <div class="page-head"><div><h1>Mon compte</h1><p>Profil, sécurité et accès API.</p></div></div>
        <div class="grid grid-2 stagger">
          <div class="stack" style="--i:0">
            <div class="card"><h3>${icon('user')} Profil</h3>
              <div class="row" style="gap:16px">
                <div class="avatar" style="width:54px;height:54px;font-size:1.2rem;border-radius:16px">${u.username.slice(0, 2)}</div>
                <div><b style="font-size:1.1rem">${u.username}</b><div class="muted small">${u.email || 'Pas d’e-mail'} · ${isAdmin() ? 'Super administrateur' : 'Utilisateur'}</div></div>
              </div>
              ${!isAdmin()
                ? html`<hr class="sep"><div class="info">
                    <div class="item"><span class="k">Sites max</span><span class="v">${u.max_sites}</span></div>
                    <div class="item"><span class="k">RAM max / site</span><span class="v">${u.max_memory_mb} Mo</span></div>
                    <div class="item"><span class="k">CPU max / site</span><span class="v">${u.max_cpus}</span></div>
                    <div class="item"><span class="k">Membre depuis</span><span class="v">${fmtDate(u.created_at, false)}</span></div>
                  </div>`
                : ''}
            </div>
            <form class="card" id="pwd"><h3>${icon('lock')} Changer de mot de passe</h3>
              <div class="field"><label>Mot de passe actuel</label><input class="input" type="password" name="current" autocomplete="current-password" required></div>
              <div class="form-grid">
                <div class="field"><label>Nouveau</label><input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></div>
                <div class="field"><label>Confirmation</label><input class="input" type="password" name="confirm" autocomplete="new-password" required></div>
              </div>
              <button class="btn primary" type="submit">${icon('check')} Mettre à jour</button>
            </form>
          </div>
          <div class="stack" style="--i:1">
            <div class="card"><div class="card-head"><h3>${icon('key')} Jetons API</h3>
              <button class="btn sm primary" id="new-token">${icon('plus')} Nouveau jeton</button></div>
              ${tokens.length
                ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Nom</th><th>Préfixe</th><th>Créé</th><th>Utilisé</th><th></th></tr></thead>
                  <tbody>${tokens.map(
                    (t) => html`<tr><td><b>${t.name}</b></td><td class="mono small">${t.prefix}…</td><td class="small">${fmtDate(t.created_at, false)}</td>
                      <td class="small">${t.last_used_at ? timeAgo(t.last_used_at) : 'jamais'}</td>
                      <td class="actions"><button class="btn sm danger" data-revoke="${t.id}" data-name="${t.name}">${icon('trash')}</button></td></tr>`
                  )}</tbody></table></div>`
                : html`<p class="muted small" style="margin:0">Aucun jeton. Créez-en un pour déployer depuis un script ou une CI.</p>`}
            </div>
            <div class="card"><h3>${icon('code')} Utiliser l'API</h3>
              <p class="muted small" style="margin-top:0">Déployer / mettre à jour un site (crée le site s'il n'existe pas avec <span class="kbd">?create=1</span>) :</p>
              ${codeBlock(`curl -H "Authorization: Bearer ezd_xxx" \\\n     -F file=@site.zip \\\n     "${origin}/api/sites/mon-site/deploy?create=1"`)}
              <p class="muted small">Lister vos sites (IP, port, statut, stats) :</p>
              ${codeBlock(`curl -H "Authorization: Bearer ezd_xxx" ${origin}/api/sites`)}
              <p class="muted small">Suivre les événements (déploiements, erreurs…) :</p>
              ${codeBlock(`curl -H "Authorization: Bearer ezd_xxx" "${origin}/api/events?since=0"`)}
            </div>
          </div>
        </div>
      </div>`
    );

    const form = $('#pwd', ctx.el);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.next.value !== form.confirm.value) return toast('error', 'Les mots de passe ne correspondent pas');
      await withButton(form.querySelector('button'), async () => {
        await post('/account/password', { current_password: form.current.value, new_password: form.next.value });
        form.reset();
        toast('success', 'Mot de passe mis à jour', 'Vos autres sessions ont été déconnectées.');
      }).catch(() => {});
    });

    $('#new-token', ctx.el).addEventListener('click', () =>
      modal({
        title: 'Nouveau jeton API',
        body: html`<form><div class="field"><label>Nom</label><input class="input" name="name" placeholder="CI GitHub, script de déploiement…" maxlength="60" required></div></form>`,
        actions: [
          { label: 'Annuler', class: 'ghost' },
          {
            label: 'Créer',
            class: 'primary',
            onClick: async ({ el }) => {
              const { token } = await post('/account/tokens', { name: el.querySelector('[name=name]').value });
              render();
              setTimeout(() => secretModal('Votre jeton API', 'Copiez-le maintenant : il ne sera plus jamais affiché.', token), 220);
            },
          },
        ],
      })
    );

    $$('[data-revoke]', ctx.el).forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: `Révoquer « ${b.dataset.name} » ?`, text: 'Les scripts qui l’utilisent ne pourront plus accéder à l’API.', confirmLabel: 'Révoquer', danger: true });
        if (!ok) return;
        await del(`/account/tokens/${b.dataset.revoke}`);
        toast('success', 'Jeton révoqué');
        render();
      })
    );
  };
  await render();
}
