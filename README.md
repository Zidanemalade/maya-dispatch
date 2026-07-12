# MAYA Dispatch — Version de production

Application de gestion des livraisons pour MAYA Delivery Service (Cotonou & Porto-Novo).

Contrairement au prototype de démonstration testé précédemment, cette version :
- utilise une **vraie base de données** (SQLite, fichier `maya.db`) qui persiste durablement ;
- **chiffre les mots de passe** (bcrypt) — jamais stockés en clair ;
- gère de **vraies sessions sécurisées** (cookies signés côté serveur) ;
- applique le **blocage après 3 échecs de connexion**, débloqué uniquement par le Boss ;
- calcule automatiquement le **cycle du 5 au 5**, les **commissions historisées**, le **prix de l'essence historisé**, etc. — toute la logique métier validée dans le prototype.

## 1. Installation (sur ton ordinateur, pour tester)

Prérequis : [Node.js](https://nodejs.org) version 18 ou plus récente.

```bash
cd maya-app
npm install
node server.js
```

Puis ouvre **http://localhost:3000** dans ton navigateur.

## 2. Comptes par défaut (à changer immédiatement après la première connexion)

| Profil | Identifiant | Mot de passe par défaut |
|---|---|---|
| Secrétaire 1 — Cotonou | `coto1` | `1234` |
| Secrétaire 2 — Cotonou | `coto2` | `1234` |
| Secrétaire 1 — Porto-Novo | `pn1` | `1234` |
| Secrétaire 2 — Porto-Novo | `pn2` | `1234` |
| Boss | — | `admin` |

Chacun peut changer son mot de passe dans l'onglet **Mon compte** (secrétaires) ou **Comptes** (Boss).

## 3. Déploiement en production (pour un usage réel au quotidien)

Cette application est un serveur Node.js classique. Trois options courantes, du plus simple au plus flexible :

### Option simple — hébergement clé en main (recommandé pour démarrer)
Services comme **Render**, **Railway** ou **Fly.io** : tu connectes ton dépôt de code, ils installent et démarrent l'application automatiquement. Compte quelques dollars par mois. Il faut monter un **disque persistant** pour que le fichier `maya.db` ne soit pas perdu à chaque redémarrage (toutes ces plateformes le permettent).

### Option VPS (plus de contrôle, un peu plus technique)
Un petit serveur privé (ex: 2-5 €/mois chez OVH, Hetzner, DigitalOcean...), avec :
```bash
npm install -g pm2
pm2 start server.js --name maya-dispatch
pm2 startup   # démarre automatiquement après un redémarrage du serveur
```
Puis un reverse proxy (nginx ou Caddy) devant, avec un certificat HTTPS gratuit (Let's Encrypt).

### Variables d'environnement importantes en production
- `SESSION_SECRET` : une longue chaîne aléatoire, différente de la valeur par défaut du code.
- `NODE_ENV=production` : active le mode sécurisé des cookies (nécessite HTTPS).
- `PORT` : le port d'écoute (défini automatiquement par la plupart des hébergeurs).

**Important : le HTTPS est indispensable en production** — sans lui, les mots de passe circulent en clair sur le réseau.

## 4. Sauvegardes

Le fichier `maya.db` contient **toutes les données** de l'entreprise. Sauvegarde-le régulièrement :
```bash
cp maya.db sauvegardes/maya-$(date +%Y-%m-%d).db
```
Idéalement via une tâche automatique quotidienne (cron) qui copie ce fichier vers un espace de stockage externe (Google Drive, Dropbox, un autre serveur...).

## 5. Structure du projet

```
maya-app/
  server.js       → serveur Express : API, authentification, logique métier
  db.js           → schéma de la base de données SQLite + données de départ
  public/
    index.html    → page HTML (charge le style et app.js)
    app.js        → interface (tableau de bord, saisie, statistiques...)
    logo-b64.txt  → logo MAYA encodé
  maya.db         → base de données (créée automatiquement au premier lancement)
```

## 6. Ce qui reste à décider avant le vrai lancement

Se référer au **cahier des charges** (section "Limites connues et scénarios à risque") pour la liste complète des points à trancher avec le client : gestion des litiges clients, changement de statut d'un livreur en cours de mois, récupération du mot de passe du Boss, etc.
