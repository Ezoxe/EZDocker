#!/usr/bin/env bash
# EZDocker — installation en une commande sur Debian 11/12/13 (et Ubuntu).
#
#   curl -fsSL https://raw.githubusercontent.com/Ezoxe/EZDocker/main/install.sh | sudo bash
#
# Variables optionnelles (mode non interactif) :
#   EZD_NONINTERACTIVE=1   aucune question, valeurs par défaut
#   EZD_PORT=80            port du panel
#   EZD_PUBLIC_HOST=...    IP / domaine affiché dans les URL des sites
#   EZD_PORT_RANGE=10000-19999
#   EZD_ADMIN_USER=admin   EZD_ADMIN_PASSWORD=...  EZD_ADMIN_EMAIL=...
#   EZD_DIR=/opt/ezdocker  EZD_BRANCH=main  EZD_REPO=https://github.com/Ezoxe/EZDocker.git
#   EZD_SOURCE=/chemin     installe depuis une copie locale au lieu de git clone
set -euo pipefail

REPO_URL="${EZD_REPO:-https://github.com/Ezoxe/EZDocker.git}"
BRANCH="${EZD_BRANCH:-main}"
INSTALL_DIR="${EZD_DIR:-/opt/ezdocker}"

if [[ -t 1 ]]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; M=$'\e[35m'; N=$'\e[0m'
else
  B=''; DIM=''; R=''; G=''; Y=''; C=''; M=''; N=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
fail() { printf '\n%s✖ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

banner() {
  printf '%s' "$M"
  cat <<'EOF'
   ______ _______  ____             _
  |  ____|___  /  |  _ \  ___   ___| | _____ _ __
  | |__     / /   | | | |/ _ \ / __| |/ / _ \ '__|
  |  __|   / /    | |_| | (_) | (__|   <  __/ |
  | |____ / /__   |____/ \___/ \___|_|\_\___|_|
  |______/_____|
EOF
  printf '%s  Déposez un .zip, votre site est en ligne.%s\n' "$DIM" "$N"
}

INTERACTIVE=0
if [[ "${EZD_NONINTERACTIVE:-0}" != "1" ]] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

ask() { # ask VAR "Question" default
  local __var=$1 __prompt=$2 __default=$3 __answer=''
  if [[ $INTERACTIVE == 1 ]]; then
    read -r -p "  ${__prompt} [${__default}] : " __answer </dev/tty || true
  fi
  printf -v "$__var" '%s' "${__answer:-$__default}"
}

ask_secret() { # ask_secret VAR "Question"  (empty = generated)
  local __var=$1 __prompt=$2 __answer=''
  if [[ $INTERACTIVE == 1 ]]; then
    read -r -s -p "  ${__prompt} (vide = généré) : " __answer </dev/tty || true
    echo
  fi
  printf -v "$__var" '%s' "$__answer"
}

port_in_use() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

gen_password() { tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 16 || true; }

detect_public_ip() {
  local ip=''
  ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [[ $ip =~ ^[0-9.]+$ ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "${ip:-127.0.0.1}"
}

# ---------------------------------------------------------------------------
banner

[[ $EUID -eq 0 ]] || fail "Lancez ce script en root : curl -fsSL … | sudo bash"
[[ -r /etc/os-release ]] || fail "Système non reconnu (/etc/os-release absent)."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  debian|raspbian) DOCKER_DISTRO=debian ;;
  ubuntu) DOCKER_DISTRO=ubuntu ;;
  *)
    if [[ "${ID_LIKE:-}" == *debian* ]]; then DOCKER_DISTRO=debian; warn "Distribution ${ID} traitée comme Debian."
    else fail "Distribution non supportée : ${PRETTY_NAME:-$ID}. Debian ou Ubuntu requis."; fi ;;
esac
ok "Système : ${PRETTY_NAME:-$ID} ($(dpkg --print-architecture))"

UPDATE=0
[[ -f "$INSTALL_DIR/.env" ]] && UPDATE=1

# --- Questions ---------------------------------------------------------------
if [[ $UPDATE == 0 ]]; then
  step "Configuration"
  DEFAULT_PORT="${EZD_PORT:-80}"
  if [[ -z "${EZD_PORT:-}" ]] && port_in_use 80; then DEFAULT_PORT=8080; warn "Le port 80 est déjà utilisé, 8080 proposé."; fi
  ask PANEL_PORT "Port du panel EZDocker" "$DEFAULT_PORT"
  [[ $PANEL_PORT =~ ^[0-9]+$ ]] && (( PANEL_PORT >= 1 && PANEL_PORT <= 65535 )) || fail "Port invalide : $PANEL_PORT"
  ask PUBLIC_HOST "Adresse publique (IP ou domaine) des sites" "${EZD_PUBLIC_HOST:-$(detect_public_ip)}"
  ask PORT_RANGE "Plage de ports pour les sites" "${EZD_PORT_RANGE:-10000-19999}"
  [[ $PORT_RANGE =~ ^([0-9]+)-([0-9]+)$ ]] || fail "Plage invalide : $PORT_RANGE (ex. 10000-19999)"
  (( BASH_REMATCH[1] >= 1024 && BASH_REMATCH[2] >= BASH_REMATCH[1] && BASH_REMATCH[2] + 10000 <= 65535 )) || fail "Plage invalide : $PORT_RANGE"
  ask ADMIN_USER "Identifiant du super admin" "${EZD_ADMIN_USER:-admin}"
  ADMIN_PASSWORD="${EZD_ADMIN_PASSWORD:-}"
  [[ -n $ADMIN_PASSWORD ]] || ask_secret ADMIN_PASSWORD "Mot de passe du super admin"
  PASSWORD_GENERATED=0
  if [[ -z $ADMIN_PASSWORD ]]; then ADMIN_PASSWORD=$(gen_password); PASSWORD_GENERATED=1; fi
  (( ${#ADMIN_PASSWORD} >= 8 )) || fail "Le mot de passe doit contenir au moins 8 caractères."
  ADMIN_EMAIL="${EZD_ADMIN_EMAIL:-}"
else
  step "Installation existante détectée dans $INSTALL_DIR : mise à jour"
fi

# --- Paquets de base -----------------------------------------------------------
step "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg openssl iproute2 tar >/dev/null
ok "ca-certificates, curl, git, gnupg, openssl"

# --- Docker --------------------------------------------------------------------
step "Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${DOCKER_DISTRO}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  CODENAME="${VERSION_CODENAME:-$(. /etc/os-release && echo "${UBUNTU_CODENAME:-}")}"
  [[ -n $CODENAME ]] || fail "Impossible de déterminer la version de la distribution."
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_DISTRO} ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  ok "Docker installé"
else
  ok "Docker déjà présent ($(docker --version | sed 's/Docker version //'))"
fi
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
if ! docker info >/dev/null 2>&1; then
  service docker start >/dev/null 2>&1 || true
  sleep 3
fi
docker info >/dev/null 2>&1 || fail "Le service Docker ne répond pas."
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || fail "Le plugin « docker compose » est introuvable. Installez docker-compose-plugin."
fi
ok "$(docker compose version)"

# --- Code ------------------------------------------------------------------------
step "Récupération d'EZDocker"
mkdir -p "$INSTALL_DIR"
if [[ -n "${EZD_SOURCE:-}" ]]; then
  [[ -f "$EZD_SOURCE/docker-compose.yml" ]] || fail "EZD_SOURCE ne contient pas EZDocker : $EZD_SOURCE"
  tar -C "$EZD_SOURCE" --exclude=./node_modules --exclude=./data --exclude=./.git --exclude=./.env -cf - . | tar -C "$INSTALL_DIR" -xf -
  ok "Copié depuis $EZD_SOURCE"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" -q
  git -C "$INSTALL_DIR" reset --hard FETCH_HEAD -q
  ok "Mis à jour ($(git -C "$INSTALL_DIR" rev-parse --short HEAD))"
else
  if [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
    TMP=$(mktemp -d)
    git clone -q --depth 1 -b "$BRANCH" "$REPO_URL" "$TMP/src"
    cp -a "$TMP/src/." "$INSTALL_DIR/"
    rm -rf "$TMP"
  else
    git clone -q --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "Cloné dans $INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- Configuration -------------------------------------------------------------
if [[ $UPDATE == 0 ]]; then
  umask 077
  cat > .env <<EOF
# EZDocker — généré le $(date -Iseconds)
EZD_PORT=${PANEL_PORT}
EZD_PUBLIC_HOST=${PUBLIC_HOST}
EZD_PORT_RANGE=${PORT_RANGE}
EZD_ADMIN_USER=${ADMIN_USER}
EZD_ADMIN_EMAIL=${ADMIN_EMAIL}
EZD_ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
  umask 022
  chmod 600 .env
  ok "Fichier .env créé"
fi
mkdir -p data
PANEL_PORT=$(grep -E '^EZD_PORT=' .env | cut -d= -f2)
PORT_RANGE=$(grep -E '^EZD_PORT_RANGE=' .env | cut -d= -f2)
PUBLIC_HOST=$(grep -E '^EZD_PUBLIC_HOST=' .env | cut -d= -f2)

# --- Lancement -------------------------------------------------------------------
step "Construction et démarrage"
BUILD_LOG=$(mktemp)
if ! docker compose up -d --build --remove-orphans >"$BUILD_LOG" 2>&1; then
  tail -n 40 "$BUILD_LOG" | sed 's/^/  /'
  fail "La construction de l'image EZDocker a échoué (journal complet : $BUILD_LOG)."
fi
tail -n 5 "$BUILD_LOG" | sed 's/^/  /'
rm -f "$BUILD_LOG"
printf '  Attente du démarrage'
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  printf '.'; sleep 2
done
echo
[[ "${HEALTHY:-0}" == 1 ]] || { docker compose logs --tail 50; fail "EZDocker ne répond pas sur le port ${PANEL_PORT}."; }
ok "EZDocker répond sur le port ${PANEL_PORT}"

# Password is only needed for the very first start.
sed -i '/^EZD_ADMIN_PASSWORD=/d' .env

install -m 0755 scripts/ezdocker /usr/local/bin/ezdocker
ok "Commande « ezdocker » installée (ezdocker help)"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PANEL_PORT}/tcp" >/dev/null
  ufw allow "${PORT_RANGE/-/:}/tcp" >/dev/null
  ok "Pare-feu ufw : ports ${PANEL_PORT} et ${PORT_RANGE} ouverts"
fi

docker image prune -f >/dev/null 2>&1 || true

# --- Résumé ----------------------------------------------------------------------
printf '\n%s%s  EZDocker est prêt ! %s\n\n' "$G" "$B" "$N"
URL="http://${PUBLIC_HOST}"
[[ $PANEL_PORT != 80 ]] && URL="${URL}:${PANEL_PORT}"
printf '  Panel        : %s%s%s\n' "$C" "$URL" "$N"
if [[ $UPDATE == 0 ]]; then
  printf '  Identifiant  : %s%s%s\n' "$B" "$ADMIN_USER" "$N"
  if [[ $PASSWORD_GENERATED == 1 ]]; then
    printf '  Mot de passe : %s%s%s  %s(généré, notez-le !)%s\n' "$B" "$ADMIN_PASSWORD" "$N" "$Y" "$N"
  else
    printf '  Mot de passe : celui que vous avez choisi\n'
  fi
fi
printf '  Sites        : ports %s\n' "$PORT_RANGE"
printf '  Dossier      : %s\n\n' "$INSTALL_DIR"
printf '  %sCommandes utiles : ezdocker status | logs | update | reset-admin-password | backup%s\n\n' "$DIM" "$N"
