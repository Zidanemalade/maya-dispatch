const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'maya.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS agences (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secretaires (
  id TEXT PRIMARY KEY,
  agence_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS boss (
  id TEXT PRIMARY KEY DEFAULT 'boss',
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS livreurs (
  id TEXT PRIMARY KEY,
  agence_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('salarie','independant')),
  salaire_mensuel REAL
);

CREATE TABLE IF NOT EXISTS taux_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  livreur_id TEXT NOT NULL,
  taux REAL NOT NULL,
  depuis TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS livraisons (
  id TEXT PRIMARY KEY,
  agence_id TEXT NOT NULL,
  secretaire_id TEXT NOT NULL,
  expediteur TEXT, contact_exp TEXT,
  destinataire TEXT, contact_dest TEXT,
  nature_colis TEXT, lieu TEXT, heure TEXT,
  montant REAL NOT NULL,
  livreur_id TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'attente',
  motif_annulation TEXT,
  date TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS depenses (
  id TEXT PRIMARY KEY,
  agence_id TEXT NOT NULL,
  date TEXT NOT NULL,
  montant REAL NOT NULL,
  note TEXT,
  livreur_id TEXT,
  secretaire_id TEXT
);

CREATE TABLE IF NOT EXISTS essence (
  id TEXT PRIMARY KEY,
  agence_id TEXT NOT NULL,
  date TEXT NOT NULL,
  livreur_id TEXT NOT NULL,
  litres REAL NOT NULL,
  prix_applique REAL NOT NULL,
  cout_total REAL NOT NULL,
  secretaire_id TEXT
);

CREATE TABLE IF NOT EXISTS prix_essence_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agence_id TEXT NOT NULL,
  prix REAL NOT NULL,
  depuis TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  who TEXT,
  agence_id TEXT,
  action TEXT,
  detail TEXT
);
`);

// ---- Seed initial data if empty ----
const agenceCount = db.prepare('SELECT COUNT(*) c FROM agences').get().c;
if (agenceCount === 0) {
  const insertAgence = db.prepare('INSERT INTO agences (id, nom) VALUES (?, ?)');
  insertAgence.run('coto', 'Cotonou');
  insertAgence.run('pn', 'Porto-Novo');

  const insertSec = db.prepare('INSERT INTO secretaires (id, agence_id, nom, password_hash) VALUES (?,?,?,?)');
  const defaultHash = bcrypt.hashSync('1234', 10);
  insertSec.run('coto1', 'coto', 'Secrétaire 1 — Cotonou', defaultHash);
  insertSec.run('coto2', 'coto', 'Secrétaire 2 — Cotonou', defaultHash);
  insertSec.run('pn1', 'pn', 'Secrétaire 1 — Porto-Novo', defaultHash);
  insertSec.run('pn2', 'pn', 'Secrétaire 2 — Porto-Novo', defaultHash);

  db.prepare('INSERT INTO boss (id, password_hash) VALUES (?, ?)').run('boss', bcrypt.hashSync('admin', 10));

  const insertPrix = db.prepare('INSERT INTO prix_essence_history (agence_id, prix, depuis) VALUES (?, ?, ?)');
  const today = new Date().toISOString().slice(0,10);
  insertPrix.run('coto', 0, today);
  insertPrix.run('pn', 0, today);

  console.log('Base de données initialisée avec les comptes par défaut (mot de passe secrétaires: 1234, Boss: admin — À CHANGER après la première connexion).');
}

module.exports = db;
