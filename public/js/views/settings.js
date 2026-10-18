import { get, put, post } from '../api.js';
import { html, mount, icon, toast, withButton, formData, copyBtn, timeAgo, $ } from '../ui.js';
import { refreshMe } from '../app.js';

function eventChecks(name, all, labels, selected) {
  return html`<div class="checks">${all.map(
    (e) => html`<label class="check"><input type="checkbox" name="${name}" value="${e}" data-list="1" ${selected.includes(e) ? 'checked' : ''}>
      <span>${labels[e]} <span class="dim small mono">${e}</span></span></label>`
  )}</div>`;
}

function sw(name, checked, label) {
  return html`<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span class="track"></span><span>${label}</span></label>`;
}

export async function settingsView(ctx) {
  const { settings: s } = await get('/admin/settings');
  const { host } = await get('/admin/overview');
  mount(
    ctx.el,
    html`<div class="page">
      <div class="page-head"><div><h1>Paramètres</h1><p>Configuration générale de la plateforme.</p></div></div>
      <form id="settings" class="grid grid-2 stagger">
        <div class="card" style="--i:0"><h3>${icon('globe')} Général</h3>
          <div class="field"><label>Nom de l'instance</label><input class="input" name="instance_name" value="${s.instance_name}" maxlength="60"></div>
          <div class="field"><label>Adresse publique affichée (IP ou nom de domaine)</label>
            <input class="input" name="public_host" value="${s.public_host}" placeholder="${host.detected_ip}">
            <span class="hint">Utilisée pour construire les URL des sites. Vide = détection automatique (${host.detected_ip}).</span></div>
          <div class="form-grid">
            <div class="field"><label>Plage de ports — début</label><input class="input" type="number" name="port_range_start" value="${s.port_range_start}"></div>
            <div class="field"><label>Plage de ports — fin</label><input class="input" type="number" name="port_range_end" value="${s.port_range_end}"></div>
          </div>
          <p class="hint" style="margin-top:-6px">Pensez à ouvrir cette plage dans votre pare-feu. Les sites existants gardent leur port.</p>
        </div>
        <div class="card" style="--i:1"><h3>${icon('sliders')} Limites par défaut</h3>
          <div class="field"><label>Taille max d'une archive (Mo)</label><input class="input" type="number" name="max_upload_mb" value="${s.max_upload_mb}"></div>
          <div class="form-grid">
            <div class="field"><label>Sites par utilisateur</label><input class="input" type="number" name="default_max_sites" value="${s.default_max_sites}"></div>
            <div class="field"><label>RAM par site (Mo)</label><input class="input" type="number" name="default_memory_mb" value="${s.default_memory_mb}"></div>
            <div class="field"><label>CPU par site</label><input class="input" type="number" step="0.1" name="default_cpus" value="${s.default_cpus}"></div>
          </div>
          <p class="hint">Appliquées aux nouveaux utilisateurs. Ajustables ensuite pour chacun.</p>
        </div>
        <div style="--i:2" class="full"><button class="btn primary" type="submit">${icon('check')} Enregistrer</button></div>
      </form>
    </div>`
  );
  const form = $('#settings', ctx.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withButton(form.querySelector('[type=submit]'), async () => {
      await put('/admin/settings', formData(form));
      await refreshMe();
      toast('success', 'Paramètres enregistrés');
    }).catch(() => {});
  });
}

const SAMPLE = (origin) => `{
  "id": "evt_42",
  "event": "site.updated",
  "label": "Site mis à jour",
  "message": "Portfolio a été mis à jour (mise à jour)",
  "timestamp": "2026-10-18T10:00:00.000Z",
  "instance": { "name": "EZDocker", "host": "203.0.113.10", "version": "1.0.0" },
  "actor": { "id": 2, "username": "jdupont" },
  "site": {
    "id": 3, "name": "Portfolio", "slug": "portfolio", "owner": "jdupont",
    "status": "running", "host": "203.0.113.10", "port": 10003,
    "url": "http://203.0.113.10:10003", "container_id": "f3a1…", "image": "ezdocker/portfolio:12"
  },
  "deployment": {
    "id": 12, "kind": "update", "source": "web", "status": "success",
    "error": null, "zip_name": "site.zip", "duration_ms": 8421
  }
}

# Événements : ${origin}/api/events?since=<dernier id>`;

const VERIFY = `// Node.js — vérifier la signature
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-ezdocker-signature']));

# Python
expected = 'sha256=' + hmac.new(SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected, request.headers['X-EZDocker-Signature'])`;

export async function notificationsView(ctx) {
  const render = async () => {
    const [{ settings: s }, { deliveries }] = await Promise.all([get('/admin/settings'), get('/admin/deliveries')]);
    if (!ctx.alive()) return;
    mount(
      ctx.el,
      html`<div class="page">
        <div class="page-head"><div><h1>Notifications & API</h1><p>Prévenez votre système interne à chaque mise en place, mise à jour ou erreur.</p></div></div>
        <form id="notif" class="grid grid-2 stagger">
          <div class="card" style="--i:0"><div class="card-head"><h3>${icon('webhook')} Webhook</h3>${sw('webhook_enabled', s.webhook_enabled, 'Activé')}</div>
            <div class="field"><label>URL appelée (POST JSON)</label><input class="input" name="webhook_url" value="${s.webhook_url}" placeholder="https://interne.exemple.fr/hooks/ezdocker"></div>
            <div class="field"><label>Secret de signature (HMAC-SHA256)</label>
              <div class="input-group"><input class="input mono" name="webhook_secret" value="${s.webhook_secret}">
                ${copyBtn(s.webhook_secret)}<button class="btn sm" type="button" id="regen">${icon('refresh')}</button></div>
              <span class="hint">Envoyé dans l'en-tête <span class="kbd">X-EZDocker-Signature: sha256=…</span>. 3 tentatives en cas d'échec.</span></div>
            <div class="field"><label>Événements envoyés</label>${eventChecks('webhook_events', s.all_events, s.event_labels, s.webhook_events)}</div>
            <button class="btn" type="button" id="test-webhook">${icon('send')} Envoyer un test</button> <span id="webhook-result" class="small"></span>
          </div>
          <div class="card" style="--i:1"><div class="card-head"><h3>${icon('mail')} E-mail (SMTP)</h3>${sw('smtp_enabled', s.smtp_enabled, 'Activé')}</div>
            <div class="form-grid">
              <div class="field"><label>Serveur SMTP</label><input class="input" name="smtp_host" value="${s.smtp_host}" placeholder="smtp.exemple.fr"></div>
              <div class="field"><label>Port</label><input class="input" type="number" name="smtp_port" value="${s.smtp_port}"></div>
              <div class="field"><label>Utilisateur</label><input class="input" name="smtp_user" value="${s.smtp_user}" autocomplete="off"></div>
              <div class="field"><label>Mot de passe</label><input class="input" type="password" name="smtp_pass" value="${s.smtp_pass}" autocomplete="new-password"></div>
              <div class="field"><label>Expéditeur</label><input class="input" name="smtp_from" value="${s.smtp_from}" placeholder="EZDocker &lt;noreply@exemple.fr&gt;"></div>
              <div class="field"><label>Destinataires</label><input class="input" name="smtp_to" value="${s.smtp_to}" placeholder="ops@exemple.fr, moi@exemple.fr"></div>
            </div>
            <div class="field">${sw('smtp_secure', s.smtp_secure, 'Connexion TLS directe (port 465)')}</div>
            <div class="field"><label>Événements envoyés</label>${eventChecks('smtp_events', s.all_events, s.event_labels, s.smtp_events)}</div>
            <button class="btn" type="button" id="test-email">${icon('send')} Envoyer un e-mail de test</button> <span id="email-result" class="small"></span>
          </div>
          <div style="--i:2"><button class="btn primary" type="submit">${icon('check')} Enregistrer</button></div>
        </form>
        <div class="grid grid-2 mt">
          <div class="card"><h3>${icon('code')} Format du webhook</h3><div class="code-block"><pre>${SAMPLE(location.origin)}</pre></div>
            <p class="small muted">Vérification de la signature :</p><div class="code-block"><pre>${VERIFY}</pre></div></div>
          <div class="card"><h3>${icon('list')} Derniers envois</h3>
            ${deliveries.length
              ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Quand</th><th>Canal</th><th>Événement</th><th>Résultat</th></tr></thead>
                <tbody>${deliveries.map(
                  (d) => html`<tr><td class="small nowrap">${timeAgo(d.created_at)}</td><td>${d.channel === 'webhook' ? 'Webhook' : 'E-mail'}</td>
                    <td class="small mono">${d.type || '—'}</td>
                    <td>${d.success
                      ? html`<span class="badge success"><span class="dot"></span>${d.status_code || 'OK'}</span>`
                      : html`<span class="badge error" title="${d.error}"><span class="dot"></span>${d.error || 'Échec'}</span>`}
                      <span class="dim small">${d.attempts > 1 ? `${d.attempts} essais` : ''}</span></td></tr>`
                )}</tbody></table></div>`
              : html`<p class="muted small">Aucun envoi pour le moment.</p>`}
          </div>
        </div>
      </div>`
    );

    const form = $('#notif', ctx.el);
    const values = () => {
      const data = formData(form);
      for (const k of ['webhook_events', 'smtp_events']) data[k] = data[k] || [];
      return data;
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await withButton(form.querySelector('[type=submit]'), async () => {
        await put('/admin/settings', values());
        toast('success', 'Notifications enregistrées');
      }).catch(() => {});
    });
    $('#regen', ctx.el).addEventListener('click', () => {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      form.webhook_secret.value = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
      toast('info', 'Nouveau secret généré', 'Pensez à enregistrer.');
    });
    $('#test-webhook', ctx.el).addEventListener('click', async (e) => {
      const out = $('#webhook-result', ctx.el);
      await withButton(e.currentTarget, async () => {
        const r = await post('/admin/settings/test-webhook', values());
        out.innerHTML = r.ok ? `<span style="color:#86efac">✓ HTTP ${r.status} en ${r.ms} ms</span>` : `<span style="color:#fca5a5">✖ ${r.status ? 'HTTP ' + r.status : r.error}</span>`;
      }).catch(() => {});
    });
    $('#test-email', ctx.el).addEventListener('click', async (e) => {
      const out = $('#email-result', ctx.el);
      await withButton(e.currentTarget, async () => {
        const r = await post('/admin/settings/test-email', values());
        out.textContent = r.ok ? '✓ E-mail envoyé' : `✖ ${r.error}`;
        out.style.color = r.ok ? '#86efac' : '#fca5a5';
      }).catch(() => {});
    });
  };
  await render();
}
