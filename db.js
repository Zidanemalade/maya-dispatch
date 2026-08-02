const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
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
      locked BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS boss (
      id TEXT PRIMARY KEY DEFAULT 'boss',
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS livreurs (
      id TEXT PRIMARY KEY,
      agence_id TEXT NOT NULL,
      nom TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('salarie','independant')),
      salaire_mensuel DOUBLE PRECISION
    );

    CREATE TABLE IF NOT EXISTS taux_history (
      id SERIAL PRIMARY KEY,
      livreur_id TEXT NOT NULL,
      taux DOUBLE PRECISION NOT NULL,
      depuis TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS livraisons (
      id TEXT PRIMARY KEY,
      agence_id TEXT NOT NULL,
      secretaire_id TEXT NOT NULL,
      expediteur TEXT, contact_exp TEXT,
      destinataire TEXT, contact_dest TEXT,
      nature_colis TEXT, lieu TEXT, heure TEXT,
      montant DOUBLE PRECISION NOT NULL,
      livreur_id TEXT NOT NULL,
      statut TEXT NOT NULL DEFAULT 'attente',
      motif_annulation TEXT,
      date TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS depenses (
      id TEXT PRIMARY KEY,
      agence_id TEXT NOT NULL,
      date TEXT NOT NULL,
      montant DOUBLE PRECISION NOT NULL,
      note TEXT,
      livreur_id TEXT,
      secretaire_id TEXT
    );

    CREATE TABLE IF NOT EXISTS essence (
      id TEXT PRIMARY KEY,
      agence_id TEXT NOT NULL,
      date TEXT NOT NULL,
      livreur_id TEXT NOT NULL,
      litres DOUBLE PRECISION NOT NULL,
      prix_applique DOUBLE PRECISION NOT NULL,
      cout_total DOUBLE PRECISION NOT NULL,
      secretaire_id TEXT
    );

    CREATE TABLE IF NOT EXISTS prix_essence_history (
      id SERIAL PRIMARY KEY,
      agence_id TEXT NOT NULL,
      prix DOUBLE PRECISION NOT NULL,
      depuis TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      who TEXT,
      agence_id TEXT,
      action TEXT,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS clients_depot (
      id TEXT PRIMARY KEY,
      nom TEXT NOT NULL,
      contact TEXT
    );

    CREATE TABLE IF NOT EXISTS produits_depot (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      agence_id TEXT NOT NULL,
      nom TEXT NOT NULL,
      reference TEXT,
      categorie TEXT,
      emplacement TEXT,
      quantite DOUBLE PRECISION NOT NULL DEFAULT 0,
      prix_normal DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ventes_depot (
      id TEXT PRIMARY KEY,
      produit_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      agence_id TEXT NOT NULL,
      quantite DOUBLE PRECISION NOT NULL,
      prix_vendu DOUBLE PRECISION NOT NULL,
      frais_livraison DOUBLE PRECISION NOT NULL DEFAULT 0,
      net DOUBLE PRECISION NOT NULL,
      destinataire TEXT, contact_dest TEXT, lieu TEXT, heure TEXT,
      date TEXT NOT NULL,
      secretaire_id TEXT,
      created_at BIGINT NOT NULL
    );
  `);

  // Migration douce : ajoute la colonne livreur_id si elle n'existe pas encore (déploiements déjà en place)
  await pool.query('ALTER TABLE ventes_depot ADD COLUMN IF NOT EXISTS livreur_id TEXT');

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM agences');
  if (rows[0].c === 0) {
    await pool.query('INSERT INTO agences (id, nom) VALUES ($1,$2), ($3,$4)', ['coto', 'Cotonou', 'pn', 'Porto-Novo']);

    const defaultHash = bcrypt.hashSync('1234', 10);
    await pool.query(
      `INSERT INTO secretaires (id, agence_id, nom, password_hash) VALUES
       ($1,$2,$3,$4), ($5,$6,$7,$8), ($9,$10,$11,$12), ($13,$14,$15,$16)`,
      ['coto1', 'coto', 'Secrétaire 1 — Cotonou', defaultHash,
       'coto2', 'coto', 'Secrétaire 2 — Cotonou', defaultHash,
       'pn1', 'pn', 'Secrétaire 1 — Porto-Novo', defaultHash,
       'pn2', 'pn', 'Secrétaire 2 — Porto-Novo', defaultHash]
    );

    await pool.query('INSERT INTO boss (id, password_hash) VALUES ($1,$2)', ['boss', bcrypt.hashSync('admin', 10)]);

    const today = new Date().toISOString().slice(0, 10);
    await pool.query('INSERT INTO prix_essence_history (agence_id, prix, depuis) VALUES ($1,$2,$3), ($4,$5,$6)',
      ['coto', 0, today, 'pn', 0, today]);

    console.log('Base de données initialisée avec les comptes par défaut (mot de passe secrétaires: 1234, Boss: admin — À CHANGER après la première connexion).');
  }
}

module.exports = { pool, init };
