const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { pool, init } = require('./db');

const app = express();
app.set('trust proxy', 1); // nécessaire derrière un proxy (Render, etc.) pour que les cookies sécurisés fonctionnent
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000, // 12h
    secure: process.env.NODE_ENV === 'production'
  }
}));

function uid() { return crypto.randomUUID(); }

// ================= Règles métier : jour / semaine / mois =================
// Calculs indépendants du fuseau horaire de la machine qui exécute le code :
// le Bénin est en UTC+1 toute l'année (pas de changement d'heure).
const BENIN_OFFSET_MIN = 60;

function businessDateISO(refDate = new Date()) {
  const benin = new Date(refDate.getTime() + BENIN_OFFSET_MIN * 60000);
  if (benin.getUTCHours() < 8) benin.setUTCDate(benin.getUTCDate() - 1);
  return benin.toISOString().slice(0, 10);
}
function todayISO() { return businessDateISO(new Date()); }

function semaineKey(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime()); monday.setUTCDate(d.getUTCDate() - dow);
  return monday.toISOString().slice(0, 10);
}
function moisRange(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  const day = d.getUTCDate();
  let debut, fin;
  if (day >= 5) { debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5)); fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 5)); }
  else { debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 5)); fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5)); }
  const key = debut.toISOString().slice(0, 10);
  const label = debut.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', timeZone: 'UTC' }) + ' → ' + fin.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return { debut, fin, key, label };
}
function currentMoisKey() { return moisRange(todayISO()).key; }

async function tauxAt(livreurId, dateISO) {
  const { rows } = await pool.query('SELECT taux, depuis FROM taux_history WHERE livreur_id = $1 ORDER BY depuis ASC', [livreurId]);
  if (rows.length === 0) return 0;
  let v = rows[0].taux;
  for (const r of rows) if (r.depuis <= dateISO) v = r.taux;
  return v;
}
async function prixEssenceAt(agenceId, dateISO) {
  const { rows } = await pool.query('SELECT prix, depuis FROM prix_essence_history WHERE agence_id = $1 ORDER BY depuis ASC', [agenceId]);
  if (rows.length === 0) return 0;
  let v = rows[0].prix;
  for (const r of rows) if (r.depuis <= dateISO) v = r.prix;
  return v;
}

async function log(who, agenceId, action, detail) {
  await pool.query('INSERT INTO audit (id, timestamp, who, agence_id, action, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [uid(), Date.now(), who, agenceId || null, action, detail]);
}

// ================= Auth middleware =================

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non authentifié' });
  next();
}
function requireBoss(req, res, next) {
  if (!req.session.user || req.session.user.type !== 'boss') return res.status(403).json({ error: 'Réservé au Boss' });
  next();
}
function agenceAutorisee(req, agenceId) {
  if (req.session.user.type === 'boss') return true;
  return req.session.user.agenceId === agenceId;
}

// Petit filet de sécurité : toute erreur async non attrapée renvoie une 500 propre au lieu de planter le serveur
function ah(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' });
  });
}

// ================= Auth routes =================

app.get('/api/public/roster', ah(async (req, res) => {
  const agences = (await pool.query('SELECT * FROM agences')).rows;
  const secretaires = (await pool.query('SELECT id, agence_id as "agenceId", nom, locked FROM secretaires')).rows;
  res.json({ agences, secretaires });
}));

app.post('/api/login', ah(async (req, res) => {
  const { type, id, password } = req.body;

  if (type === 'boss') {
    const { rows } = await pool.query('SELECT * FROM boss WHERE id = $1', ['boss']);
    const boss = rows[0];
    if (!boss || !bcrypt.compareSync(password || '', boss.password_hash)) {
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    req.session.user = { type: 'boss' };
    return res.json({ ok: true, user: { type: 'boss' } });
  }

  const { rows } = await pool.query('SELECT * FROM secretaires WHERE id = $1', [id]);
  const sec = rows[0];
  if (!sec) return res.status(404).json({ error: 'Compte introuvable.' });
  if (sec.locked) return res.status(423).json({ error: 'Ce compte est bloqué. Demande au Boss de le débloquer.', locked: true });

  if (bcrypt.compareSync(password || '', sec.password_hash)) {
    await pool.query('UPDATE secretaires SET failed_attempts = 0 WHERE id = $1', [id]);
    req.session.user = { type: 'secretaire', id: sec.id, nom: sec.nom, agenceId: sec.agence_id };
    return res.json({ ok: true, user: req.session.user });
  } else {
    const attempts = sec.failed_attempts + 1;
    if (attempts >= 3) {
      await pool.query('UPDATE secretaires SET failed_attempts = $1, locked = TRUE WHERE id = $2', [attempts, id]);
      return res.status(423).json({ error: 'Trop d’essais incorrects : compte bloqué. Seul le Boss peut le débloquer.', locked: true });
    }
    await pool.query('UPDATE secretaires SET failed_attempts = $1 WHERE id = $2', [attempts, id]);
    return res.status(401).json({ error: `Mot de passe incorrect (${attempts}/3 essais).` });
  }
}));

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// ================= État global (lecture) =================

app.get('/api/state', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  const agenceView = req.query.agenceView;
  let scope;
  if (user.type === 'secretaire') scope = [user.agenceId];
  else {
    if (agenceView === 'all' || !agenceView) scope = (await pool.query('SELECT id FROM agences')).rows.map(a => a.id);
    else scope = [agenceView];
  }

  const agences = (await pool.query('SELECT * FROM agences')).rows;
  const secretaires = (await pool.query('SELECT id, agence_id as "agenceId", nom, locked FROM secretaires')).rows;

  const livreursRaw = (await pool.query('SELECT * FROM livreurs WHERE agence_id = ANY($1)', [scope])).rows;
  const livreurs = [];
  for (const l of livreursRaw) {
    const hist = (await pool.query('SELECT taux, depuis FROM taux_history WHERE livreur_id = $1 ORDER BY depuis ASC', [l.id])).rows;
    livreurs.push({ id: l.id, agenceId: l.agence_id, nom: l.nom, type: l.type, salaireMensuel: l.salaire_mensuel, tauxHistory: hist });
  }

  const livraisonsRaw = (await pool.query('SELECT * FROM livraisons WHERE agence_id = ANY($1) ORDER BY created_at DESC', [scope])).rows;
  const livraisons = livraisonsRaw.map(c => ({
    id: c.id, agenceId: c.agence_id, secretaireId: c.secretaire_id, expediteur: c.expediteur, contactExp: c.contact_exp,
    destinataire: c.destinataire, contactDest: c.contact_dest, natureColis: c.nature_colis, lieu: c.lieu, heure: c.heure,
    montant: c.montant, livreurId: c.livreur_id, statut: c.statut, motifAnnulation: c.motif_annulation, date: c.date, createdAt: Number(c.created_at)
  }));

  const depensesRaw = (await pool.query('SELECT * FROM depenses WHERE agence_id = ANY($1)', [scope])).rows;
  const depenses = depensesRaw.map(d => ({ id: d.id, agenceId: d.agence_id, date: d.date, montant: d.montant, note: d.note, livreurId: d.livreur_id, secretaireId: d.secretaire_id }));

  const essenceRaw = (await pool.query('SELECT * FROM essence WHERE agence_id = ANY($1)', [scope])).rows;
  const essence = essenceRaw.map(e => ({ id: e.id, agenceId: e.agence_id, date: e.date, livreurId: e.livreur_id, litres: e.litres, prixApplique: e.prix_applique, coutTotal: e.cout_total, secretaireId: e.secretaire_id }));

  const prixEssence = {};
  for (const a of agences) prixEssence[a.id] = (await pool.query('SELECT prix, depuis FROM prix_essence_history WHERE agence_id = $1 ORDER BY depuis ASC', [a.id])).rows;

  let audit = [];
  if (user.type === 'boss') {
    const auditRaw = (await pool.query('SELECT * FROM audit WHERE agence_id IS NULL OR agence_id = ANY($1) ORDER BY timestamp DESC LIMIT 200', [scope])).rows;
    audit = auditRaw.map(a => ({ ...a, timestamp: Number(a.timestamp) }));
  }

  const clientsDepot = (await pool.query('SELECT * FROM clients_depot ORDER BY nom ASC')).rows
    .map(c => ({ id: c.id, nom: c.nom, contact: c.contact, actif: c.actif }));

  const produitsDepotRaw = (await pool.query('SELECT * FROM produits_depot WHERE agence_id = ANY($1)', [scope])).rows;
  const produitsDepot = produitsDepotRaw.map(p => ({
    id: p.id, clientId: p.client_id, agenceId: p.agence_id, nom: p.nom, reference: p.reference,
    categorie: p.categorie, emplacement: p.emplacement, quantite: p.quantite, prixNormal: p.prix_normal
  }));

  const ventesDepotRaw = (await pool.query('SELECT * FROM ventes_depot WHERE agence_id = ANY($1) ORDER BY created_at DESC', [scope])).rows;
  const ventesDepot = ventesDepotRaw.map(v => ({
    id: v.id, produitId: v.produit_id, clientId: v.client_id, agenceId: v.agence_id, quantite: v.quantite,
    prixVendu: v.prix_vendu, fraisLivraison: v.frais_livraison, net: v.net, destinataire: v.destinataire,
    contactDest: v.contact_dest, lieu: v.lieu, heure: v.heure, date: v.date, secretaireId: v.secretaire_id, createdAt: Number(v.created_at),
    livreurId: v.livreur_id, statut: v.statut, motifAnnulation: v.motif_annulation
  }));

  res.json({ agences, secretaires, livreurs, livraisons, depenses, essence, prixEssence, audit, clientsDepot, produitsDepot, ventesDepot, todayISO: todayISO(), currentMoisKey: currentMoisKey() });
}));

// ================= Livraisons =================

app.post('/api/livraisons', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  if (user.type !== 'secretaire') return res.status(403).json({ error: 'Réservé aux secrétaires' });
  const { expediteur, contactExp, destinataire, contactDest, natureColis, lieu, heure, montant, livreurId } = req.body;
  const id = uid();
  await pool.query(
    `INSERT INTO livraisons (id, agence_id, secretaire_id, expediteur, contact_exp, destinataire, contact_dest, nature_colis, lieu, heure, montant, livreur_id, statut, date, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, user.agenceId, user.id, expediteur, contactExp, destinataire, contactDest, natureColis, lieu, heure, Number(montant) || 0, livreurId, 'attente', todayISO(), Date.now()]
  );
  await log(user.nom, user.agenceId, 'Livraison ajoutée', `${expediteur} → ${destinataire} (${montant} F)`);
  res.json({ ok: true, id });
}));

app.post('/api/livraisons/:id/advance', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM livraisons WHERE id = $1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, c.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  const order = ['attente', 'cours', 'livree'];
  const idx = order.indexOf(c.statut);
  if (idx < order.length - 1) {
    await pool.query('UPDATE livraisons SET statut = $1 WHERE id = $2', [order[idx + 1], c.id]);
    await log(req.session.user.nom || 'Boss', c.agence_id, 'Statut mis à jour', `${c.expediteur} → ${order[idx + 1]}`);
  }
  res.json({ ok: true });
}));

app.post('/api/livraisons/:id/cancel', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM livraisons WHERE id = $1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, c.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  const { motif } = req.body;
  await pool.query('UPDATE livraisons SET statut = $1, motif_annulation = $2 WHERE id = $3', ['annulee', motif, c.id]);
  await log(req.session.user.nom || 'Boss', c.agence_id, 'Livraison annulée', `${c.expediteur} · motif: ${motif}`);
  res.json({ ok: true });
}));

app.post('/api/livraisons/:id/edit', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM livraisons WHERE id = $1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, c.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  if (c.statut === 'livree' || c.statut === 'annulee') {
    return res.status(400).json({ error: 'Impossible de modifier une livraison déjà livrée ou annulée.' });
  }
  const { expediteur, contactExp, destinataire, contactDest, natureColis, lieu, heure, montant, livreurId } = req.body;
  await pool.query(
    `UPDATE livraisons SET expediteur=$1, contact_exp=$2, destinataire=$3, contact_dest=$4, nature_colis=$5, lieu=$6, heure=$7, montant=$8, livreur_id=$9 WHERE id=$10`,
    [expediteur, contactExp, destinataire, contactDest, natureColis, lieu, heure, Number(montant) || 0, livreurId, c.id]
  );
  await log(req.session.user.nom || 'Boss', c.agence_id, 'Livraison modifiée', `${expediteur} → ${destinataire} (${montant} F)`);
  res.json({ ok: true });
}));

// ================= Dépenses =================

app.post('/api/depenses', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  const { agenceId, montant, note, livreurId } = req.body;
  if (!agenceAutorisee(req, agenceId)) return res.status(403).json({ error: 'Non autorisé' });
  await pool.query('INSERT INTO depenses (id, agence_id, date, montant, note, livreur_id, secretaire_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uid(), agenceId, todayISO(), Number(montant) || 0, note, livreurId || null, user.type === 'boss' ? null : user.id]);
  await log(user.type === 'boss' ? 'Boss' : user.nom, agenceId, 'Dépense enregistrée', `${montant} F — ${note}`);
  res.json({ ok: true });
}));

// ================= Essence =================

app.post('/api/essence', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  const { agenceId, livreurId, litres } = req.body;
  if (!agenceAutorisee(req, agenceId)) return res.status(403).json({ error: 'Non autorisé' });
  const prix = await prixEssenceAt(agenceId, todayISO());
  const coutTotal = Number(litres) * prix;
  await pool.query('INSERT INTO essence (id, agence_id, date, livreur_id, litres, prix_applique, cout_total, secretaire_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [uid(), agenceId, todayISO(), livreurId, Number(litres) || 0, prix, coutTotal, user.type === 'boss' ? null : user.id]);
  await log(user.type === 'boss' ? 'Boss' : user.nom, agenceId, 'Essence enregistrée', `${litres} L`);
  res.json({ ok: true });
}));

app.post('/api/prix-essence', requireBoss, ah(async (req, res) => {
  const { agenceId, prix } = req.body;
  await pool.query('INSERT INTO prix_essence_history (agence_id, prix, depuis) VALUES ($1,$2,$3)', [agenceId, Number(prix), todayISO()]);
  await log('Boss', agenceId, 'Prix essence modifié', `${prix} F/L`);
  res.json({ ok: true });
}));

// ================= Livreurs =================

app.post('/api/livreurs', requireBoss, ah(async (req, res) => {
  const { agenceId, nom, type, taux, salaire } = req.body;
  const id = uid();
  await pool.query('INSERT INTO livreurs (id, agence_id, nom, type, salaire_mensuel) VALUES ($1,$2,$3,$4,$5)',
    [id, agenceId, nom, type, type === 'salarie' ? (Number(salaire) || 0) : null]);
  if (type === 'independant') {
    await pool.query('INSERT INTO taux_history (livreur_id, taux, depuis) VALUES ($1,$2,$3)', [id, Number(taux) || 0, todayISO()]);
  }
  await log('Boss', agenceId, 'Livreur ajouté', nom);
  res.json({ ok: true, id });
}));

app.post('/api/livreurs/:id/taux', requireBoss, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM livreurs WHERE id = $1', [req.params.id]);
  const l = rows[0];
  if (!l) return res.status(404).json({ error: 'Introuvable' });
  await pool.query('INSERT INTO taux_history (livreur_id, taux, depuis) VALUES ($1,$2,$3)', [l.id, Number(req.body.taux), todayISO()]);
  await log('Boss', l.agence_id, 'Taux modifié', `${l.nom} → ${req.body.taux}%`);
  res.json({ ok: true });
}));

app.post('/api/livreurs/:id/salaire', requireBoss, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM livreurs WHERE id = $1', [req.params.id]);
  const l = rows[0];
  if (!l) return res.status(404).json({ error: 'Introuvable' });
  await pool.query('UPDATE livreurs SET salaire_mensuel = $1 WHERE id = $2', [Number(req.body.salaire) || 0, l.id]);
  await log('Boss', l.agence_id, 'Salaire modifié', `${l.nom} → ${req.body.salaire} F/mois`);
  res.json({ ok: true });
}));

// ================= Comptes =================

app.post('/api/account/password', requireAuth, ah(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum).' });
  const hash = bcrypt.hashSync(newPassword, 10);
  const user = req.session.user;
  if (user.type === 'boss') await pool.query('UPDATE boss SET password_hash = $1 WHERE id = $2', [hash, 'boss']);
  else await pool.query('UPDATE secretaires SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  await log(user.type === 'boss' ? 'Boss' : user.nom, user.agenceId, 'Mot de passe modifié', 'Auto-modification');
  res.json({ ok: true });
}));

app.post('/api/comptes/:id/password', requireBoss, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM secretaires WHERE id = $1', [req.params.id]);
  const sec = rows[0];
  if (!sec) return res.status(404).json({ error: 'Introuvable' });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Mot de passe trop court.' });
  await pool.query('UPDATE secretaires SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), sec.id]);
  await log('Boss', sec.agence_id, 'Mot de passe modifié', sec.nom);
  res.json({ ok: true });
}));

app.post('/api/comptes/:id/unlock', requireBoss, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM secretaires WHERE id = $1', [req.params.id]);
  const sec = rows[0];
  if (!sec) return res.status(404).json({ error: 'Introuvable' });
  await pool.query('UPDATE secretaires SET locked = FALSE, failed_attempts = 0 WHERE id = $1', [sec.id]);
  await log('Boss', sec.agence_id, 'Compte débloqué', sec.nom);
  res.json({ ok: true });
}));

app.post('/api/agences/:id/rename', requireBoss, ah(async (req, res) => {
  await pool.query('UPDATE agences SET nom = $1 WHERE id = $2', [req.body.nom, req.params.id]);
  res.json({ ok: true });
}));

// ================= Dépôt (clients, produits en stock, ventes/sorties) =================

app.post('/api/depot/clients', requireAuth, ah(async (req, res) => {
  const { nom, contact } = req.body;
  const id = uid();
  await pool.query('INSERT INTO clients_depot (id, nom, contact) VALUES ($1,$2,$3)', [id, nom, contact || null]);
  await log(req.session.user.type === 'boss' ? 'Boss' : req.session.user.nom, null, 'Client dépôt ajouté', nom);
  res.json({ ok: true, id });
}));

app.post('/api/depot/clients/:id/toggle-actif', requireBoss, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clients_depot WHERE id = $1', [req.params.id]);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  const nouveauStatut = !c.actif;
  await pool.query('UPDATE clients_depot SET actif = $1 WHERE id = $2', [nouveauStatut, c.id]);
  await log('Boss', null, nouveauStatut ? 'Client dépôt réactivé' : 'Client dépôt désactivé', c.nom);
  res.json({ ok: true, actif: nouveauStatut });
}));

app.post('/api/depot/produits', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  const { clientId, agenceId, nom, reference, categorie, emplacement, quantite, prixNormal } = req.body;
  if (!agenceAutorisee(req, agenceId)) return res.status(403).json({ error: 'Non autorisé' });
  const id = uid();
  await pool.query(
    `INSERT INTO produits_depot (id, client_id, agence_id, nom, reference, categorie, emplacement, quantite, prix_normal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, clientId, agenceId, nom, reference || null, categorie || null, emplacement || null, Number(quantite) || 0, Number(prixNormal) || 0]
  );
  await log(user.type === 'boss' ? 'Boss' : user.nom, agenceId, 'Produit dépôt ajouté', `${nom} (x${quantite})`);
  res.json({ ok: true, id });
}));

app.post('/api/depot/produits/:id/restock', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  const { rows } = await pool.query('SELECT * FROM produits_depot WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, p.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  const qte = Number(req.body.quantite) || 0;
  await pool.query('UPDATE produits_depot SET quantite = quantite + $1 WHERE id = $2', [qte, p.id]);
  await log(user.type === 'boss' ? 'Boss' : user.nom, p.agence_id, 'Réapprovisionnement', `${p.nom} +${qte}`);
  res.json({ ok: true });
}));

app.post('/api/depot/ventes', requireAuth, ah(async (req, res) => {
  const user = req.session.user;
  const { produitId, quantite, prixVendu, fraisLivraison, destinataire, contactDest, lieu, heure, livreurId } = req.body;
  const { rows } = await pool.query('SELECT * FROM produits_depot WHERE id = $1', [produitId]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  if (!agenceAutorisee(req, p.agence_id)) return res.status(403).json({ error: 'Non autorisé' });

  const qte = Number(quantite) || 0;
  const prix = Number(prixVendu) || 0;
  const frais = Number(fraisLivraison) || 0;
  const net = prix - frais;
  const id = uid();

  await pool.query(
    `INSERT INTO ventes_depot (id, produit_id, client_id, agence_id, quantite, prix_vendu, frais_livraison, net, destinataire, contact_dest, lieu, heure, date, secretaire_id, created_at, livreur_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, produitId, p.client_id, p.agence_id, qte, prix, frais, net, destinataire || null, contactDest || null, lieu || null, heure || null, todayISO(), user.type === 'boss' ? null : user.id, Date.now(), livreurId || null]
  );
  const nouvelleQuantite = p.quantite - qte;
  await pool.query('UPDATE produits_depot SET quantite = $1 WHERE id = $2', [nouvelleQuantite, p.id]);

  await log(user.type === 'boss' ? 'Boss' : user.nom, p.agence_id, 'Sortie de stock (dépôt)', `${p.nom} x${qte} — ${prix} F` + (nouvelleQuantite < 0 ? ' ⚠ stock négatif' : ''));
  res.json({ ok: true, id, stockRestant: nouvelleQuantite });
}));

app.post('/api/depot/ventes/:id/cancel', requireAuth, ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ventes_depot WHERE id = $1', [req.params.id]);
  const v = rows[0];
  if (!v) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, v.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  if (v.statut === 'annulee') return res.status(400).json({ error: 'Cette sortie est déjà annulée.' });
  const { motif } = req.body;

  await pool.query('UPDATE ventes_depot SET statut = $1, motif_annulation = $2 WHERE id = $3', ['annulee', motif, v.id]);
  // Restitution automatique du stock : la quantité sortie retourne dans le stock du produit
  await pool.query('UPDATE produits_depot SET quantite = quantite + $1 WHERE id = $2', [v.quantite, v.produit_id]);

  const user = req.session.user;
  await log(user.type === 'boss' ? 'Boss' : user.nom, v.agence_id, 'Sortie de stock annulée', `${v.quantite} unité(s) restituées au stock · motif: ${motif}`);
  res.json({ ok: true });
}));

// ================= Export complet (sauvegarde manuelle) =================

app.get('/api/export/xlsx', requireBoss, ah(async (req, res) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MAYA Dispatch';
  wb.created = new Date();

  async function addSheet(name, sql, columns) {
    const { rows } = await pool.query(sql);
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || 18 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));
  }

  await addSheet('Agences', 'SELECT id, nom FROM agences ORDER BY nom',
    [{ header: 'ID', key: 'id' }, { header: 'Nom', key: 'nom' }]);

  await addSheet('Secretaires', 'SELECT id, agence_id, nom, locked FROM secretaires ORDER BY agence_id, nom',
    [{ header: 'ID', key: 'id' }, { header: 'Agence', key: 'agence_id' }, { header: 'Nom', key: 'nom' }, { header: 'Bloqué', key: 'locked' }]);

  await addSheet('Livreurs', 'SELECT id, agence_id, nom, type, salaire_mensuel FROM livreurs ORDER BY agence_id, nom',
    [{ header: 'ID', key: 'id' }, { header: 'Agence', key: 'agence_id' }, { header: 'Nom', key: 'nom' }, { header: 'Type', key: 'type' }, { header: 'Salaire mensuel', key: 'salaire_mensuel' }]);

  await addSheet('Taux commissions', 'SELECT livreur_id, taux, depuis FROM taux_history ORDER BY livreur_id, depuis',
    [{ header: 'Livreur ID', key: 'livreur_id' }, { header: 'Taux (%)', key: 'taux' }, { header: 'Depuis', key: 'depuis' }]);

  await addSheet('Livraisons', `SELECT date, agence_id, secretaire_id, expediteur, contact_exp, destinataire, contact_dest, nature_colis, lieu, heure, montant, livreur_id, statut, motif_annulation FROM livraisons ORDER BY date DESC`,
    [{ header: 'Date', key: 'date' }, { header: 'Agence', key: 'agence_id' }, { header: 'Secrétaire', key: 'secretaire_id' }, { header: 'Expéditeur', key: 'expediteur' },
     { header: 'Contact exp.', key: 'contact_exp' }, { header: 'Destinataire', key: 'destinataire' }, { header: 'Contact dest.', key: 'contact_dest' },
     { header: 'Colis', key: 'nature_colis' }, { header: 'Lieu', key: 'lieu' }, { header: 'Heure', key: 'heure' }, { header: 'Montant', key: 'montant' },
     { header: 'Livreur ID', key: 'livreur_id' }, { header: 'Statut', key: 'statut' }, { header: 'Motif annulation', key: 'motif_annulation' }]);

  await addSheet('Depenses', 'SELECT date, agence_id, montant, note, livreur_id, secretaire_id FROM depenses ORDER BY date DESC',
    [{ header: 'Date', key: 'date' }, { header: 'Agence', key: 'agence_id' }, { header: 'Montant', key: 'montant' }, { header: 'Note', key: 'note' }, { header: 'Livreur ID', key: 'livreur_id' }, { header: 'Secrétaire', key: 'secretaire_id' }]);

  await addSheet('Essence', 'SELECT date, agence_id, livreur_id, litres, prix_applique, cout_total, secretaire_id FROM essence ORDER BY date DESC',
    [{ header: 'Date', key: 'date' }, { header: 'Agence', key: 'agence_id' }, { header: 'Livreur ID', key: 'livreur_id' }, { header: 'Litres', key: 'litres' }, { header: 'Prix appliqué', key: 'prix_applique' }, { header: 'Coût total', key: 'cout_total' }, { header: 'Secrétaire', key: 'secretaire_id' }]);

  await addSheet('Clients depot', 'SELECT id, nom, contact FROM clients_depot ORDER BY nom',
    [{ header: 'ID', key: 'id' }, { header: 'Nom', key: 'nom' }, { header: 'Contact', key: 'contact' }]);

  await addSheet('Produits depot', 'SELECT id, client_id, agence_id, nom, reference, categorie, emplacement, quantite, prix_normal FROM produits_depot ORDER BY client_id, nom',
    [{ header: 'ID', key: 'id' }, { header: 'Client ID', key: 'client_id' }, { header: 'Agence', key: 'agence_id' }, { header: 'Produit', key: 'nom' },
     { header: 'Référence', key: 'reference' }, { header: 'Catégorie', key: 'categorie' }, { header: 'Emplacement', key: 'emplacement' }, { header: 'Stock', key: 'quantite' }, { header: 'Prix normal', key: 'prix_normal' }]);

  await addSheet('Ventes depot', 'SELECT date, agence_id, client_id, produit_id, quantite, prix_vendu, frais_livraison, net, destinataire, contact_dest, lieu, heure, secretaire_id FROM ventes_depot ORDER BY date DESC',
    [{ header: 'Date', key: 'date' }, { header: 'Agence', key: 'agence_id' }, { header: 'Client ID', key: 'client_id' }, { header: 'Produit ID', key: 'produit_id' },
     { header: 'Quantité', key: 'quantite' }, { header: 'Prix vendu', key: 'prix_vendu' }, { header: 'Frais livraison', key: 'frais_livraison' }, { header: 'Net', key: 'net' },
     { header: 'Destinataire', key: 'destinataire' }, { header: 'Contact dest.', key: 'contact_dest' }, { header: 'Lieu', key: 'lieu' }, { header: 'Heure', key: 'heure' }, { header: 'Secrétaire', key: 'secretaire_id' }]);

  await addSheet('Journal audit', 'SELECT timestamp, who, agence_id, action, detail FROM audit ORDER BY timestamp DESC LIMIT 5000',
    [{ header: 'Horodatage', key: 'timestamp' }, { header: 'Qui', key: 'who' }, { header: 'Agence', key: 'agence_id' }, { header: 'Action', key: 'action' }, { header: 'Détail', key: 'detail' }]);

  const dateStr = todayISO();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="maya-export-${dateStr}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
  await log('Boss', null, 'Export de sauvegarde', 'Export Excel complet téléchargé');
}));

const PORT = process.env.PORT || 3000;
init()
  .then(() => { app.listen(PORT, () => console.log(`MAYA Dispatch — serveur démarré sur le port ${PORT}`)); })
  .catch(err => { console.error('Échec de l’initialisation de la base de données :', err); process.exit(1); });
