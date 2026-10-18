#!/usr/bin/env bash
# End-to-end scenario against a real installation (install.sh + Docker). Used by CI.
#   EZD_PORT=8080 EZD_ADMIN_PASSWORD=... bash test/e2e.sh
set -euo pipefail

PANEL="http://127.0.0.1:${EZD_PORT:-8080}"
API="$PANEL/api"
ADMIN_PASSWORD="${EZD_ADMIN_PASSWORD:?EZD_ADMIN_PASSWORD requis}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
HOOK_LOG="$WORK/hooks.jsonl"
ADMIN_JAR="$WORK/admin.jar"
BOB_JAR="$WORK/bob.jar"

pass() { printf '\e[32m✔\e[0m %s\n' "$*"; }
die() { printf '\e[31m✖ %s\e[0m\n' "$*" >&2; exit 1; }

# --- Webhook receiver -----------------------------------------------------------
python3 - "$HOOK_LOG" <<'PY' &
import http.server, json, sys
log = sys.argv[1]
class Hook(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['content-length'])).decode()
        with open(log, 'a') as f:
            f.write(json.dumps({'event': self.headers.get('x-ezdocker-event'),
                                'sig': self.headers.get('x-ezdocker-signature'), 'body': body}) + '\n')
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', 9999), Hook).serve_forever()
PY
HOOK_PID=$!
trap 'kill $HOOK_PID 2>/dev/null || true' EXIT

# --- Helpers ----------------------------------------------------------------------
api() { # api JAR METHOD PATH [JSON]
  local jar=$1 method=$2 path=$3 body=${4:-}
  if [[ -n $body ]]; then
    curl -sS -b "$jar" -c "$jar" -X "$method" -H 'x-ezdocker: 1' -H 'content-type: application/json' -d "$body" "$API$path"
  else
    curl -sS -b "$jar" -c "$jar" -X "$method" -H 'x-ezdocker: 1' "$API$path"
  fi
}
tok() { curl -sS -X "$1" -H "authorization: Bearer $TOKEN" "$API$2"; }
make_zip() { python3 -c 'import shutil,sys; shutil.make_archive(sys.argv[2], "zip", sys.argv[1])' "$1" "${2%.zip}"; }
deploy() { # deploy ZIP SLUG [query] -> deployment id
  curl -sS -H "authorization: Bearer $TOKEN" -F "file=@$1" "$API/sites/$2/deploy${3:-}" | jq -er '.deployment.id'
}
wait_deploy() { # wait_deploy SLUG ID -> final status
  local status=''
  for _ in $(seq 1 150); do
    status=$(tok GET "/sites/$1/deployments/$2" | jq -r '.deployment.status')
    [[ $status == success || $status == failed ]] && break
    sleep 2
  done
  if [[ $status != success ]]; then tok GET "/sites/$1/deployments/$2" | jq -r '.deployment.log' | tail -n 40 >&2; fi
  echo "$status"
}
site_body() { curl -sS --max-time 10 "http://127.0.0.1:$PORT/" || true; }
site_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/" || true; }

# --- Scenario ---------------------------------------------------------------------
[[ $(curl -sS "$API/health" | jq -r '.docker') == true ]] || die "Docker non joignable par EZDocker"
pass "Panel en ligne et Docker joignable"

api "$ADMIN_JAR" POST /auth/login "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -e '.user.role == "superadmin"' >/dev/null || die "Connexion admin"
pass "Connexion super admin"

api "$ADMIN_JAR" PUT /admin/settings '{"webhook_enabled":true,"webhook_url":"http://127.0.0.1:9999/hook","webhook_secret":"e2e-secret"}' >/dev/null
pass "Webhook configuré"

BOB_TMP=$(api "$ADMIN_JAR" POST /admin/users '{"username":"bob","max_sites":3}' | jq -er '.password')
api "$BOB_JAR" POST /auth/login "{\"username\":\"bob\",\"password\":\"$BOB_TMP\"}" >/dev/null
api "$BOB_JAR" POST /account/password "{\"current_password\":\"$BOB_TMP\",\"new_password\":\"bob-password-e2e\"}" | jq -e '.ok' >/dev/null || die "Changement de mot de passe"
TOKEN=$(api "$BOB_JAR" POST /account/tokens '{"name":"e2e"}' | jq -er '.token')
pass "Utilisateur créé par l'admin, mot de passe changé, jeton API créé"

mkdir -p "$WORK/v1" && cp -r "$ROOT/examples/hello-site/." "$WORK/v1/"
make_zip "$WORK/v1" "$WORK/v1.zip"
DEP1=$(deploy "$WORK/v1.zip" hello '?create=1')
[[ $(wait_deploy hello "$DEP1") == success ]] || die "Premier déploiement"
PORT=$(tok GET /sites/hello | jq -er '.site.public_port')
site_body | grep -q 'Hello EZDocker' || die "Le site ne répond pas sur le port $PORT"
pass "Mise en place : site en ligne sur le port $PORT"

for _ in 1 2 3 4 5; do site_body >/dev/null; done
STATS=$(tok GET /sites/hello/stats)
(( $(jq '.summary.requests_24h' <<<"$STATS") >= 6 )) || die "Statistiques : $(jq -c .summary <<<"$STATS")"
(( $(jq '.summary.visitors_24h' <<<"$STATS") >= 1 )) || die "Visiteurs uniques"
(( $(jq '.recent | length' <<<"$STATS") >= 6 )) || die "Derniers accès"
pass "Statistiques d'accès comptabilisées ($(jq '.summary.requests_24h' <<<"$STATS") requêtes)"

INFO=$(tok GET /sites/hello)
[[ $(jq -r '.runtime.running' <<<"$INFO") == true ]] || die "Conteneur non démarré"
[[ -n $(jq -r '.runtime.ip // empty' <<<"$INFO") ]] || die "IP du conteneur absente"
docker port ezd-hello | grep -q '127.0.0.1' || die "Le conteneur doit être publié sur 127.0.0.1 uniquement"
pass "Infos techniques : IP conteneur $(jq -r '.runtime.ip' <<<"$INFO"), port interne $(jq -r '.site.internal_port' <<<"$INFO")"

mkdir -p "$WORK/v2" && cp -r "$WORK/v1/." "$WORK/v2/"
sed -i 's/Hello EZDocker !/Version 2/' "$WORK/v2/index.html"
make_zip "$WORK/v2" "$WORK/v2.zip"
DEP2=$(deploy "$WORK/v2.zip" hello)
[[ $(wait_deploy hello "$DEP2") == success ]] || die "Mise à jour"
site_body | grep -q 'Version 2' || die "La mise à jour n'est pas servie"
pass "Mise à jour servie"

mkdir -p "$WORK/crash"
printf 'FROM alpine:3.20\nEXPOSE 80\nCMD ["sh", "-c", "echo boom; exit 3"]\n' > "$WORK/crash/Dockerfile"
make_zip "$WORK/crash" "$WORK/crash.zip"
DEP3=$(deploy "$WORK/crash.zip" hello)
[[ $(wait_deploy hello "$DEP3" 2>/dev/null) == failed ]] || die "Le conteneur qui plante aurait dû échouer"
site_body | grep -q 'Version 2' || die "La version précédente aurait dû être restaurée"
pass "Conteneur qui plante : échec détecté, version précédente remise en ligne"

mkdir -p "$WORK/broken"
printf 'FROM alpine:3.20\nRUN exit 1\n' > "$WORK/broken/Dockerfile"
make_zip "$WORK/broken" "$WORK/broken.zip"
DEP4=$(deploy "$WORK/broken.zip" hello)
[[ $(wait_deploy hello "$DEP4" 2>/dev/null) == failed ]] || die "Le build cassé aurait dû échouer"
site_body | grep -q 'Version 2' || die "Le site doit rester en ligne après un build raté"
pass "Build en erreur : site inchangé"

ROLL=$(tok POST "/sites/hello/deployments/$DEP1/rollback" | jq -er '.deployment.id')
[[ $(wait_deploy hello "$ROLL") == success ]] || die "Restauration"
site_body | grep -q 'Hello EZDocker' || die "La restauration n'est pas servie"
pass "Restauration de la version #$DEP1"

tok POST /sites/hello/stop >/dev/null
[[ $(site_code) == 503 ]] || die "Un site arrêté doit répondre 503"
tok POST /sites/hello/start >/dev/null
sleep 2
[[ $(site_code) == 200 ]] || die "Le site redémarré doit répondre 200"
pass "Arrêt / démarrage"

CFG=$(curl -sS -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"env":{"GREETING":"bonjour"}}' "$API/sites/hello" | jq -er '.deployment.id')
[[ $(wait_deploy hello "$CFG") == success ]] || die "Nouvelle configuration"
docker inspect ezd-hello --format '{{json .Config.Env}}' | grep -q 'GREETING=bonjour' || die "Variable d'environnement absente"
pass "Variables d'environnement appliquées"

docker restart ezdocker >/dev/null
for _ in $(seq 1 30); do curl -fsS "$API/health" >/dev/null 2>&1 && break; sleep 2; done
sleep 2
[[ $(site_code) == 200 ]] || die "Le site doit rester accessible après un redémarrage d'EZDocker"
pass "Redémarrage d'EZDocker sans coupure des sites"

sleep 3
for evt in site.created site.deployed site.updated site.deploy_failed site.stopped site.started; do
  grep -q "\"event\": \"$evt\"" "$HOOK_LOG" || die "Webhook $evt non reçu"
done
python3 - "$HOOK_LOG" <<'PY' || die "Signature webhook invalide"
import hmac, hashlib, json, sys
for line in open(sys.argv[1]):
    h = json.loads(line)
    expected = 'sha256=' + hmac.new(b'e2e-secret', h['body'].encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, h['sig']):
        sys.exit(1)
PY
pass "Webhooks reçus et signatures valides ($(wc -l <"$HOOK_LOG") envois)"

tok GET '/events?since=0&type=site.deploy_failed' | jq -e '.events | length >= 2' >/dev/null || die "Journal d'événements"
pass "API d'événements"

tok DELETE /sites/hello | jq -e '.ok' >/dev/null || die "Suppression"
sleep 1
[[ -z $(docker ps -aq --filter name=ezd-hello) ]] || die "Conteneur non supprimé"
[[ $(site_code) == 000 ]] || die "Le port doit être libéré"
pass "Suppression : conteneur, images et port libérés"

printf '\n\e[32mScénario complet réussi.\e[0m\n'
