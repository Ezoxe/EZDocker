import { post } from '../api.js';
import { html, mount, $, icon, setLoading, toast } from '../ui.js';
import { state, startApp, refreshMe } from '../app.js';

function shake(card) {
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}

export function showLogin() {
  mount(
    $('#app'),
    html`<div class="auth-wrap">
      <form class="auth-card" id="login-form" autocomplete="on">
        <div class="brand">
          <div class="logo-mark"></div>
          <div><h1>${state.instance?.name || 'EZDocker'}</h1><div class="tagline">Votre site en ligne en un glisser-déposer</div></div>
        </div>
        <div id="login-error"></div>
        <div class="field"><label for="username">Identifiant</label>
          <input class="input" id="username" name="username" autocomplete="username" required autofocus></div>
        <div class="field"><label for="password">Mot de passe</label>
          <input class="input" id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn primary" type="submit">${icon('lock')} Se connecter</button>
        <div class="auth-foot">Les comptes sont créés par l'administrateur.</div>
      </form>
    </div>`
  );
  const form = $('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    setLoading(btn, true);
    $('#login-error').innerHTML = '';
    try {
      await post('/auth/login', { username: form.username.value.trim(), password: form.password.value });
      const me = await refreshMe();
      if (me.user.must_change_password) return showForcePassword();
      startApp();
      toast('success', `Bonjour ${me.user.username} 👋`);
    } catch (err) {
      mount($('#login-error'), html`<div class="alert error">${icon('alert')}<div>${err.message}</div></div>`);
      shake(form);
      form.password.select();
    } finally {
      setLoading(btn, false);
    }
  });
}

export function showForcePassword() {
  mount(
    $('#app'),
    html`<div class="auth-wrap">
      <form class="auth-card" id="pwd-form">
        <div class="brand">
          <div class="logo-mark"></div>
          <div><h1>Nouveau mot de passe</h1><div class="tagline">Pour votre sécurité, choisissez votre propre mot de passe.</div></div>
        </div>
        <div id="pwd-error"></div>
        <div class="field"><label>Mot de passe actuel (temporaire)</label>
          <input class="input" name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>Nouveau mot de passe</label>
          <input class="input" name="next" type="password" autocomplete="new-password" minlength="8" required>
          <span class="hint">8 caractères minimum.</span></div>
        <div class="field"><label>Confirmation</label>
          <input class="input" name="confirm" type="password" autocomplete="new-password" required></div>
        <button class="btn primary" type="submit">${icon('check')} Enregistrer</button>
      </form>
    </div>`
  );
  const form = $('#pwd-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    $('#pwd-error').innerHTML = '';
    if (form.next.value !== form.confirm.value) {
      mount($('#pwd-error'), html`<div class="alert error">${icon('alert')}<div>Les deux mots de passe ne correspondent pas.</div></div>`);
      return shake(form);
    }
    setLoading(btn, true);
    try {
      await post('/account/password', { current_password: form.current.value, new_password: form.next.value });
      await refreshMe();
      toast('success', 'Mot de passe mis à jour');
      startApp();
    } catch (err) {
      mount($('#pwd-error'), html`<div class="alert error">${icon('alert')}<div>${err.message}</div></div>`);
      shake(form);
    } finally {
      setLoading(btn, false);
    }
  });
}
