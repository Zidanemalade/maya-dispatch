const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000, // 12h
    secure: process.env.NODE_ENV === 'production' // nécessite HTTPS en production
  }
}));

function uid() { return crypto.randomUUID(); }

// ================= Règles métier : jour / semaine / mois =================

// La journée métier commence à 8h — avant 8h, on est encore dans la journée précédente
function businessDateISO(d = new Date()) {
  const copy = new Date(d);
  if (copy.getHours() < 8) copy.setDate(copy.getDate() - 1);
  return copy.toISOString().slice(0, 10);
}
function todayISO() { return businessDateISO(new Date()); }

function semaineKey(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 0=lundi
  const monday = new Date(d); monday.setDate(d.getDate() - dow);
  return monday.toISOString().slice(0, 10);
}
function isSamePeriod(dateISO, period) {
  if (period === 'jour') return dateISO === todayISO();
  if (period === 'semaine') return semaineKey(dateISO) === semaineKey(todayISO());
  if (period === 'mois') return moisRange(dateISO).key === currentMoisKey();
  return true;
}
function moisRange(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const day = d.getDate();
  let debut, fin;
  if (day >= 5) { debut = new Date(d.getFullYear(), d.getMonth(), 5); fin = new Date(d.getFullYear(), d.getMonth() + 1, 5); }
  else { debut = new Date(d.getFullYear(), d.getMonth() - 1, 5); fin = new Date(d.getFullYear(), d.getMonth(), 5); }
  const key = debut.toISOString().slice(0, 10);
  const label = debut.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' → ' + fin.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  return { debut, fin, key, label };
}
function currentMoisKey() { return moisRange(todayISO()).key; }

function tauxAt(livreurId, dateISO) {
  const rows = db.prepare('SELECT taux, depuis FROM taux_history WHERE livreur_id = ? ORDER BY depuis ASC').all(livreurId);
  if (rows.length === 0) return 0;
  let v = rows[0].taux;
  for (const r of rows) if (r.depuis <= dateISO) v = r.taux;
  return v;
}
function prixEssenceAt(agenceId, dateISO) {
  const rows = db.prepare('SELECT prix, depuis FROM prix_essence_history WHERE agence_id = ? ORDER BY depuis ASC').all(agenceId);
  if (rows.length === 0) return 0;
  let v = rows[0].prix;
  for (const r of rows) if (r.depuis <= dateISO) v = r.prix;
  return v;
}

function log(who, agenceId, action, detail) {
  db.prepare('INSERT INTO audit (id, timestamp, who, agence_id, action, detail) VALUES (?,?,?,?,?,?)')
    .run(uid(), Date.now(), who, agenceId || null, action, detail);
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
// Une secrétaire ne peut agir que sur sa propre agence
function agenceAutorisee(req, agenceId) {
  if (req.session.user.type === 'boss') return true;
  return req.session.user.agenceId === agenceId;
}

// ================= Auth routes =================

app.get('/api/public/roster', (req, res) => {
  const agences = db.prepare('SELECT * FROM agences').all();
  const secretaires = db.prepare('SELECT id, agence_id as agenceId, nom, locked FROM secretaires').all();
  res.json({ agences, secretaires });
});

app.post('/api/login', (req, res) => {
  const { type, id, password } = req.body;
  if (type === 'boss') {
    const boss = db.prepare('SELECT * FROM boss WHERE id = ?').get('boss');
    if (!boss || !bcrypt.compareSync(password || '', boss.password_hash)) {
      return res.status(401).json({ error: 'Mot de passe incorrect.' });
    }
    req.session.user = { type: 'boss' };
    return res.json({ ok: true, user: { type: 'boss' } });
  }

  const sec = db.prepare('SELECT * FROM secretaires WHERE id = ?').get(id);
  if (!sec) return res.status(404).json({ error: 'Compte introuvable.' });
  if (sec.locked) return res.status(423).json({ error: 'Ce compte est bloqué. Demande au Boss de le débloquer.', locked: true });

  if (bcrypt.compareSync(password || '', sec.password_hash)) {
    db.prepare('UPDATE secretaires SET failed_attempts = 0 WHERE id = ?').run(id);
    req.session.user = { type: 'secretaire', id: sec.id, nom: sec.nom, agenceId: sec.agence_id };
    return res.json({ ok: true, user: req.session.user });
  } else {
    const attempts = sec.failed_attempts + 1;
    if (attempts >= 3) {
      db.prepare('UPDATE secretaires SET failed_attempts = ?, locked = 1 WHERE id = ?').run(attempts, id);
      return res.status(423).json({ error: 'Trop d’essais incorrects : compte bloqué. Seul le Boss peut le débloquer.', locked: true });
    }
    db.prepare('UPDATE secretaires SET failed_attempts = ? WHERE id = ?').run(attempts, id);
    return res.status(401).json({ error: `Mot de passe incorrect (${attempts}/3 essais).` });
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// ================= État global (lecture) =================

app.get('/api/state', requireAuth, (req, res) => {
  const user = req.session.user;
  const agenceView = req.query.agenceView; // 'coto' | 'pn' | 'all' (boss uniquement)
  let scope;
  if (user.type === 'secretaire') scope = [user.agenceId];
  else scope = (agenceView === 'all' || !agenceView) ? db.prepare('SELECT id FROM agences').all().map(a => a.id) : [agenceView];

  const agences = db.prepare('SELECT * FROM agences').all();
  const secretaires = db.prepare('SELECT id, agence_id as agenceId, nom, locked FROM secretaires').all();

  const livreurs = db.prepare(`SELECT * FROM livreurs WHERE agence_id IN (${scope.map(() => '?').join(',')})`).all(...scope)
    .map(l => ({
      id: l.id, agenceId: l.agence_id, nom: l.nom, type: l.type, salaireMensuel: l.salaire_mensuel,
      tauxHistory: db.prepare('SELECT taux, depuis FROM taux_history WHERE livreur_id = ? ORDER BY depuis ASC').all(l.id)
    }));

  const livraisons = db.prepare(`SELECT * FROM livraisons WHERE agence_id IN (${scope.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...scope)
    .map(c => ({
      id: c.id, agenceId: c.agence_id, secretaireId: c.secretaire_id, expediteur: c.expediteur, contactExp: c.contact_exp,
      destinataire: c.destinataire, contactDest: c.contact_dest, natureColis: c.nature_colis, lieu: c.lieu, heure: c.heure,
      montant: c.montant, livreurId: c.livreur_id, statut: c.statut, motifAnnulation: c.motif_annulation, date: c.date, createdAt: c.created_at
    }));

  const depenses = db.prepare(`SELECT * FROM depenses WHERE agence_id IN (${scope.map(() => '?').join(',')})`).all(...scope)
    .map(d => ({ id: d.id, agenceId: d.agence_id, date: d.date, montant: d.montant, note: d.note, livreurId: d.livreur_id, secretaireId: d.secretaire_id }));

  const essence = db.prepare(`SELECT * FROM essence WHERE agence_id IN (${scope.map(() => '?').join(',')})`).all(...scope)
    .map(e => ({ id: e.id, agenceId: e.agence_id, date: e.date, livreurId: e.livreur_id, litres: e.litres, prixApplique: e.prix_applique, coutTotal: e.cout_total, secretaireId: e.secretaire_id }));

  const prixEssence = {};
  for (const a of agences) prixEssence[a.id] = db.prepare('SELECT prix, depuis FROM prix_essence_history WHERE agence_id = ? ORDER BY depuis ASC').all(a.id);

  const audit = user.type === 'boss'
    ? db.prepare(`SELECT * FROM audit WHERE agence_id IS NULL OR agence_id IN (${scope.map(() => '?').join(',')}) ORDER BY timestamp DESC LIMIT 200`).all(...scope)
    : [];

  res.json({
    agences, secretaires, livreurs, livraisons, depenses, essence, prixEssence, audit,
    todayISO: todayISO(), currentMoisKey: currentMoisKey()
  });
});

// ================= Livraisons =================

app.post('/api/livraisons', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.type !== 'secretaire') return res.status(403).json({ error: 'Réservé aux secrétaires' });
  const { expediteur, contactExp, destinataire, contactDest, natureColis, lieu, heure, montant, livreurId } = req.body;
  const id = uid();
  db.prepare(`INSERT INTO livraisons (id, agence_id, secretaire_id, expediteur, contact_exp, destinataire, contact_dest, nature_colis, lieu, heure, montant, livreur_id, statut, date, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, user.agenceId, user.id, expediteur, contactExp, destinataire, contactDest, natureColis, lieu, heure, Number(montant) || 0, livreurId, 'attente', todayISO(), Date.now()
  );
  log(user.nom, user.agenceId, 'Livraison ajoutée', `${expediteur} → ${destinataire} (${montant} F)`);
  res.json({ ok: true, id });
});

app.post('/api/livraisons/:id/advance', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM livraisons WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, c.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  const order = ['attente', 'cours', 'livree'];
  const idx = order.indexOf(c.statut);
  if (idx < order.length - 1) {
    db.prepare('UPDATE livraisons SET statut = ? WHERE id = ?').run(order[idx + 1], c.id);
    log(req.session.user.nom || 'Boss', c.agence_id, 'Statut mis à jour', `${c.expediteur} → ${order[idx + 1]}`);
  }
  res.json({ ok: true });
});

app.post('/api/livraisons/:id/cancel', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM livraisons WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (!agenceAutorisee(req, c.agence_id)) return res.status(403).json({ error: 'Non autorisé' });
  const { motif } = req.body;
  db.prepare('UPDATE livraisons SET statut = ?, motif_annulation = ? WHERE id = ?').run('annulee', motif, c.id);
  log(req.session.user.nom || 'Boss', c.agence_id, 'Livraison annulée', `${c.expediteur} · motif: ${motif}`);
  res.json({ ok: true });
});

// ================= Dépenses =================

app.post('/api/depenses', requireAuth, (req, res) => {
  const user = req.session.user;
  const { agenceId, montant, note, livreurId } = req.body;
  if (!agenceAutorisee(req, agenceId)) return res.status(403).json({ error: 'Non autorisé' });
  db.prepare('INSERT INTO depenses (id, agence_id, date, montant, note, livreur_id, secretaire_id) VALUES (?,?,?,?,?,?,?)')
    .run(uid(), agenceId, todayISO(), Number(montant) || 0, note, livreurId || null, user.type === 'boss' ? null : user.id);
  log(user.type === 'boss' ? 'Boss' : user.nom, agenceId, 'Dépense enregistrée', `${montant} F — ${note}`);
  res.json({ ok: true });
});

// ================= Essence =================

app.post('/api/essence', requireAuth, (req, res) => {
  const user = req.session.user;
  const { agenceId, livreurId, litres } = req.body;
  if (!agenceAutorisee(req, agenceId)) return res.status(403).json({ error: 'Non autorisé' });
  const prix = prixEssenceAt(agenceId, todayISO());
  const coutTotal = Number(litres) * prix;
  db.prepare('INSERT INTO essence (id, agence_id, date, livreur_id, litres, prix_applique, cout_total, secretaire_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid(), agenceId, todayISO(), livreurId, Number(litres) || 0, prix, coutTotal, user.type === 'boss' ? null : user.id);
  log(user.type === 'boss' ? 'Boss' : user.nom, agenceId, 'Essence enregistrée', `${litres} L`);
  res.json({ ok: true });
});

app.post('/api/prix-essence', requireBoss, (req, res) => {
  const { agenceId, prix } = req.body;
  db.prepare('INSERT INTO prix_essence_history (agence_id, prix, depuis) VALUES (?,?,?)').run(agenceId, Number(prix), todayISO());
  log('Boss', agenceId, 'Prix essence modifié', `${prix} F/L`);
  res.json({ ok: true });
});

// ================= Livreurs =================

app.post('/api/livreurs', requireBoss, (req, res) => {
  const { agenceId, nom, type, taux, salaire } = req.body;
  const id = uid();
  db.prepare('INSERT INTO livreurs (id, agence_id, nom, type, salaire_mensuel) VALUES (?,?,?,?,?)')
    .run(id, agenceId, nom, type, type === 'salarie' ? (Number(salaire) || 0) : null);
  if (type === 'independant') {
    db.prepare('INSERT INTO taux_history (livreur_id, taux, depuis) VALUES (?,?,?)').run(id, Number(taux) || 0, todayISO());
  }
  log('Boss', agenceId, 'Livreur ajouté', nom);
  res.json({ ok: true, id });
});

app.post('/api/livreurs/:id/taux', requireBoss, (req, res) => {
  const l = db.prepare('SELECT * FROM livreurs WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('INSERT INTO taux_history (livreur_id, taux, depuis) VALUES (?,?,?)').run(l.id, Number(req.body.taux), todayISO());
  log('Boss', l.agence_id, 'Taux modifié', `${l.nom} → ${req.body.taux}%`);
  res.json({ ok: true });
});

app.post('/api/livreurs/:id/salaire', requireBoss, (req, res) => {
  const l = db.prepare('SELECT * FROM livreurs WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('UPDATE livreurs SET salaire_mensuel = ? WHERE id = ?').run(Number(req.body.salaire) || 0, l.id);
  log('Boss', l.agence_id, 'Salaire modifié', `${l.nom} → ${req.body.salaire} F/mois`);
  res.json({ ok: true });
});

// ================= Comptes =================

app.post('/api/account/password', requireAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum).' });
  const hash = bcrypt.hashSync(newPassword, 10);
  const user = req.session.user;
  if (user.type === 'boss') db.prepare('UPDATE boss SET password_hash = ? WHERE id = ?').run(hash, 'boss');
  else db.prepare('UPDATE secretaires SET password_hash = ? WHERE id = ?').run(hash, user.id);
  log(user.type === 'boss' ? 'Boss' : user.nom, user.agenceId, 'Mot de passe modifié', 'Auto-modification');
  res.json({ ok: true });
});

app.post('/api/comptes/:id/password', requireBoss, (req, res) => {
  const sec = db.prepare('SELECT * FROM secretaires WHERE id = ?').get(req.params.id);
  if (!sec) return res.status(404).json({ error: 'Introuvable' });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Mot de passe trop court.' });
  db.prepare('UPDATE secretaires SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), sec.id);
  log('Boss', sec.agence_id, 'Mot de passe modifié', sec.nom);
  res.json({ ok: true });
});

app.post('/api/comptes/:id/unlock', requireBoss, (req, res) => {
  const sec = db.prepare('SELECT * FROM secretaires WHERE id = ?').get(req.params.id);
  if (!sec) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('UPDATE secretaires SET locked = 0, failed_attempts = 0 WHERE id = ?').run(sec.id);
  log('Boss', sec.agence_id, 'Compte débloqué', sec.nom);
  res.json({ ok: true });
});

app.post('/api/agences/:id/rename', requireBoss, (req, res) => {
  db.prepare('UPDATE agences SET nom = ? WHERE id = ?').run(req.body.nom, req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MAYA Dispatch — serveur démarré sur le port ${PORT}`));
