# MAYA Dispatch — Version de production (gratuite)

Application de gestion des livraisons pour MAYA Delivery Service (Cotonou & Porto-Novo).

Cette version utilise :
- **Supabase** (base de données PostgreSQL) — plan gratuit permanent
- **Render** (hébergement du serveur) — plan gratuit
- Coût réel : **0 F CFA/mois**

**Compromis à connaître avec cette configuration 100 % gratuite :**
- Le serveur Render gratuit "s'endort" après ~15 minutes sans visite : la première requête après une pause peut prendre 30 à 60 secondes.
- Le projet Supabase gratuit peut se mettre en pause après **7 jours consécutifs sans aucune activité** (pas de problème si l'application est utilisée quotidiennement ; à surveiller si l'agence ferme plus d'une semaine). Une visite sur le tableau de bord Supabase suffit à le réactiver en cas de pause.
- Aucun fournisseur ne garantit qu'un plan gratuit reste gratuit indéfiniment (rare, mais possible qu'ils changent leurs conditions).

## 1. Créer la base de données (Supabase — gratuit)

1. Va sur [supabase.com](https://supabase.com), crée un compte (gratuit, via GitHub ou email).
2. Crée un nouveau projet (choisis une région proche, ex: Europe si rien de plus proche du Bénin n'est proposé).
3. Une fois le projet créé, va dans **Project Settings → Database**.
4. Cherche la section **Connection string** → onglet **URI**. Copie cette adresse (elle ressemble à `postgresql://postgres:[MOT-DE-PASSE]@...supabase.co:5432/postgres`).
5. Garde cette adresse précieusement — c'est la clé qui connecte l'application à sa base de données.

## 2. Installer et tester en local (optionnel)

```bash
cd maya-app
npm install
DATABASE_URL="colle-ici-l-adresse-supabase" node server.js
```
Ouvre **http://localhost:3000**.

## 3. Déployer sur Render (gratuit)

1. Pousse ce code sur GitHub (comme fait précédemment).
2. Sur Render, **New → Blueprint**, sélectionne le dépôt. Le fichier `render.yaml` configure tout automatiquement.
3. Render va demander de renseigner manuellement la variable **DATABASE_URL** (elle n'est pas générée automatiquement) : colle l'adresse Supabase récupérée à l'étape 1.
4. Clique "Apply" — aucune carte bancaire n'est nécessaire avec cette configuration.

## 4. Comptes par défaut (à changer immédiatement après la première connexion)

| Profil | Identifiant | Mot de passe par défaut |
|---|---|---|
| Secrétaire 1 — Cotonou | `coto1` | `1234` |
| Secrétaire 2 — Cotonou | `coto2` | `1234` |
| Secrétaire 1 — Porto-Novo | `pn1` | `1234` |
| Secrétaire 2 — Porto-Novo | `pn2` | `1234` |
| Boss | — | `admin` |

## 5. Sauvegardes

Même gratuite, la base Supabase peut être sauvegardée manuellement : dans le tableau de bord Supabase → **Database → Backups**, ou via un export SQL périodique. Ne néglige pas cette étape — c'est la seule protection contre une perte de données.

## 6. Passer un jour au plan payant

Si l'activité grandit et que les compromis du plan gratuit deviennent gênants (lenteur au réveil, risque de pause), il suffit de changer `plan: free` en `plan: starter` dans `render.yaml` et de mettre à niveau le projet Supabase — aucune autre modification du code n'est nécessaire.

## 7. Structure du projet

```
maya-app/
  server.js       → serveur Express : API, authentification, logique métier
  db.js           → connexion PostgreSQL (Supabase) + schéma + données de départ
  public/
    index.html    → page HTML
    app.js        → interface (tableau de bord, saisie, statistiques...)
    logo-b64.txt   → logo MAYA encodé
```
