# EZDocker — Conception

Date : 2026-10-18

## Objectif

Plateforme web ultra simple pour mettre en ligne un site packagé en `.zip` contenant un `Dockerfile` à la racine. L'utilisateur dépose le zip, EZDocker l'extrait, construit l'image, lance le conteneur et l'expose automatiquement sur un port libre (`http://IP:port`). Mise à jour = déposer un nouveau zip (interface ou API).

## Décisions

| Sujet | Choix |
|---|---|
| Accès aux sites | `http://IP:port`, port attribué automatiquement dans une plage configurable (défaut 10000-19999) |
| Notifications | Webhook HTTP JSON signé HMAC-SHA256 + e-mail SMTP + API REST (jetons Bearer) avec journal d'événements |
| Stack | Node.js 24, Express 5, SQLite intégré (`node:sqlite`), front HTML/CSS/JS sans build, dockerode |
| Hébergement d'EZDocker | Lui-même dans un conteneur (`network_mode: host`, socket Docker monté), installé par `install.sh` sur Debian |
| Dépôt | `github.com/Ezoxe/EZDocker`, public |

## Architecture

Un seul processus Node :

- **API + panel** (Express) sur le port du panel (défaut 80).
- **Proxy par site** : EZDocker écoute sur le port public de chaque site et relaie vers le conteneur, publié uniquement sur `127.0.0.1:(port public + 10000)`. Le proxy compte les accès (requêtes, visiteurs uniques, bande passante, codes HTTP, temps de réponse) et sert une page propre si le site est arrêté ou en démarrage. WebSocket supporté.
- **Déployeur** : file d'attente (1 déploiement à la fois par site). Étapes : extraction sécurisée du zip → `docker build` (logs en direct via SSE) → bascule de conteneur avec rollback automatique si le nouveau conteneur ne démarre pas → nettoyage (3 dernières images conservées).
- **Moniteur** : écoute les événements Docker (`die`, `oom`) pour détecter les plantages.
- **Notifier** : chaque événement est enregistré, puis envoyé au webhook (3 tentatives) et par e-mail selon la configuration.

## Rôles

- **Super admin** (créé à l'installation) : gère les utilisateurs (création, limites, désactivation), voit et gère tous les sites, configure webhook/SMTP/plage de ports/limites, consulte événements et santé de la machine.
- **Utilisateur** : crée et gère ses sites (dépôt, mise à jour, rollback, start/stop/restart, variables d'environnement, logs, stats), change son mot de passe, crée des jetons API.

Mot de passe temporaire à changer à la première connexion pour les comptes créés par le super admin.

## Événements

`site.created`, `deployment.started`, `site.deployed` (mise en place), `site.updated` (mise à jour), `site.deploy_failed` (erreur), `site.crashed`, `site.started`, `site.stopped`, `site.deleted`.

Webhook : `POST` JSON, en-têtes `X-EZDocker-Event`, `X-EZDocker-Delivery`, `X-EZDocker-Signature: sha256=<hmac>`.

## Sécurité

Mots de passe scrypt, sessions en base (cookie httpOnly SameSite=Lax), en-tête anti-CSRF obligatoire pour les mutations via cookie, limitation des tentatives de connexion, extraction zip protégée (zip-slip, taille, nombre d'entrées, liens symboliques ignorés), conteneurs limités (RAM, CPU, PIDs, `no-new-privileges`) sur un réseau dédié sans communication inter-conteneurs.

## Tests

- Tests unitaires `node:test` : extraction zip, ports, auth, signature webhook, proxy + stats.
- E2E GitHub Actions : exécution de `install.sh` sur runner Ubuntu, connexion, création utilisateur et site, dépôt du zip d'exemple, vérification que le site répond sur son port, que les stats comptent les accès et que le webhook est reçu, puis mise à jour.
