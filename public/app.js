(function(){
  const root = document.getElementById('d3-app');
  let LOGO_URI = '';
  let user = null;
  let currentAgenceView = null;
  let activeTab = null;
  let period = 'jour';
  let archiveSubTab = 'jours';
  let expandedWeekKey = null;
  let expandedDayKey = null;
  let editingLivraisonId = null;
  let data = null;
  let loaded = false;
  let pollTimer = null;
  let loginError = '';
  let loginMode = 'grid'; // grid | password
  let loginTarget = null; // {isBoss, secretaireId, nom}

  function fmt(n){ return new Intl.NumberFormat('fr-FR').format(Math.round(n||0)); }
  function esc(s){ const d=document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML; }

  async function api(path, opts){
    const res = await fetch(path, Object.assign({ headers: {'Content-Type':'application/json'} }, opts));
    let body = null;
    try { body = await res.json(); } catch(e) {}
    if (!res.ok) { const err = new Error((body&&body.error)||'Erreur serveur'); err.status = res.status; err.body = body; throw err; }
    return body;
  }

  async function loadLogo(){
    try { const r = await fetch('/logo-b64.txt'); LOGO_URI = 'data:image/png;base64,' + (await r.text()).trim(); } catch(e){ LOGO_URI=''; }
  }

  async function checkSession(){
    try { const r = await api('/api/me'); user = r.user; } catch(e) { user = null; }
  }

  async function loadState(){
    if (!user) return;
    const q = (user.type==='boss') ? ('?agenceView=' + encodeURIComponent(currentAgenceView||'all')) : '';
    try {
      data = await api('/api/state' + q);
      loaded = true;
    } catch(e) {
      if (e.status === 401) { user = null; }
    }
    render();
  }

  // ---- period helpers : calculs volontairement indépendants du fuseau horaire
  // du navigateur (le Bénin est en UTC+1 toute l'année, sans changement d'heure) ----
  function semaineKeyLocal(dateISO){
    const d = new Date(dateISO+'T00:00:00Z');
    const dow = (d.getUTCDay()+6)%7;
    const monday = new Date(d.getTime()); monday.setUTCDate(d.getUTCDate()-dow);
    return monday.toISOString().slice(0,10);
  }
  function isSamePeriod(dateISO, p){
    if (!data) return false;
    if (p==='jour') return dateISO === data.todayISO;
    if (p==='semaine') return semaineKeyLocal(dateISO) === semaineKeyLocal(data.todayISO);
    if (p==='mois') return moisRangeLocal(dateISO).key === data.currentMoisKey;
    return true;
  }
  function moisRangeLocal(dateISO){
    const d = new Date(dateISO+'T00:00:00Z');
    const day = d.getUTCDate();
    let debut, fin;
    if (day >= 5) { debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5)); fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 5)); }
    else { debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()-1, 5)); fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5)); }
    const key = debut.toISOString().slice(0,10);
    const label = debut.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',timeZone:'UTC'}) + ' → ' + fin.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
    return { debut, fin, key, label };
  }
  function weekRangeLocal(dateISO){
    const monday = new Date(semaineKeyLocal(dateISO)+'T00:00:00Z');
    const saturday = new Date(monday.getTime()); saturday.setUTCDate(monday.getUTCDate()+5);
    const label = 'Semaine du ' + monday.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',timeZone:'UTC'}) + ' au ' + saturday.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
    return { debut:monday, fin:saturday, key:semaineKeyLocal(dateISO), label };
  }
  function tauxAt(livreur, dateISO){
    if (!livreur.tauxHistory || livreur.tauxHistory.length===0) return 0;
    const sorted = [...livreur.tauxHistory].sort((a,b)=>a.depuis.localeCompare(b.depuis));
    let v = sorted[0].taux;
    for (const h of sorted) if (h.depuis <= dateISO) v = h.taux;
    return v;
  }
  function livreurById(id){ return data.livreurs.find(l=>l.id===id); }
  function secretaireById(id){ return data.secretaires.find(s=>s.id===id); }
  function agenceById(id){ return data.agences.find(a=>a.id===id); }
  function agenceNom(id){ const a = agenceById(id); return a ? a.nom : '—'; }

  function livraisonTotals(list){
    const valid = list.filter(c=>c.statut!=='annulee');
    const agg = p => { const f = valid.filter(c=>isSamePeriod(c.date,p)); return { nb:f.length, montant:f.reduce((s,c)=>s+c.montant,0) }; };
    return { jour:agg('jour'), semaine:agg('semaine'), mois:agg('mois') };
  }
  function depenseTotals(list){
    const agg = p => { const f = list.filter(d=>isSamePeriod(d.date,p)); return { montant:f.reduce((s,d)=>s+d.montant,0) }; };
    return { jour:agg('jour'), semaine:agg('semaine'), mois:agg('mois') };
  }
  function essenceTotals(list){
    const agg = p => { const f = list.filter(e=>isSamePeriod(e.date,p)); return { litres:f.reduce((s,e)=>s+e.litres,0), cout:f.reduce((s,e)=>s+e.coutTotal,0) }; };
    return { jour:agg('jour'), semaine:agg('semaine'), mois:agg('mois') };
  }
  function totalsBlock(periods, metricFn){
    return `<div class="d3-panel">
      <h3>Totaux</h3>
      <div class="d3-kpi-row" style="grid-template-columns:repeat(3,1fr);">
        <div class="d3-kpi"><p class="d3-kpi-label">Aujourd'hui</p>${metricFn(periods.jour)}</div>
        <div class="d3-kpi"><p class="d3-kpi-label">Cette semaine</p>${metricFn(periods.semaine)}</div>
        <div class="d3-kpi amber"><p class="d3-kpi-label">Ce mois</p>${metricFn(periods.mois)}</div>
      </div>
    </div>`;
  }

  function scopeAgences(){
    if (user.type==='secretaire') return [user.agenceId];
    if (currentAgenceView==='all' || !currentAgenceView) return data.agences.map(a=>a.id);
    return [currentAgenceView];
  }
  function filterByScope(list){ const scope = scopeAgences(); return list.filter(x=>scope.includes(x.agenceId)); }

  function livreurOptions(agenceId){
    return data.livreurs.filter(l=>l.agenceId===agenceId).map(l=>`<option value="${l.id}">${esc(l.nom)} (${l.type==='salarie'?'salarié':'indépendant'})</option>`).join('');
  }

  // ================= Rendering =================
  function render(){
    if (!loaded && user) { root.innerHTML = 'Chargement…'; return; }
    if (!user) { stopPoll(); renderLogin(); return; }
    const isBoss = user.type === 'boss';
    const tabs = isBoss
      ? [['dashboard','Tableau de bord'],['stats','Par livreur'],['livraisons','Livraisons'],['depenses','Dépenses'],['essence','Essence'],['livreurs','Livreurs'],['comptes','Comptes'],['archives','Archives'],['audit','Journal']]
      : [['saisie','Nouvelle livraison'],['mes-livraisons','Mes livraisons'],['depenses','Dépenses'],['essence','Essence'],['mon-compte','Mon compte']];
    if (!activeTab || !tabs.find(t=>t[0]===activeTab)) activeTab = tabs[0][0];

    root.innerHTML = `
      <div class="d3-wrap">
        <div class="d3-header">
          <div style="display:flex; align-items:center; gap:12px;">
            ${LOGO_URI?`<img src="${LOGO_URI}" alt="Maya Delivery Service" style="width:52px;">`:''}
            <div>
              <p class="d3-eyebrow">MAYA SERVICES · Suivi des livraisons</p>
              <h1 class="d3-title">Dispatch</h1>
              <p class="d3-who">Connecté(e) : <strong>${isBoss?'Boss':esc(user.nom)}</strong>${!isBoss?' · '+esc(agenceNom(user.agenceId)):''}<button class="d3-logout" id="btn-logout">Changer de compte</button></p>
            </div>
          </div>
          <div class="d3-tabs">${tabs.map(t=>`<button class="d3-tab ${activeTab===t[0]?'active':''}" data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
        </div>
        ${isBoss ? `<div class="d3-agence-switch">
          ${data.agences.map(a=>`<button data-agence-view="${a.id}" class="${currentAgenceView===a.id?'active':''}">${esc(a.nom)}</button>`).join('')}
          <button data-agence-view="all" class="${(currentAgenceView==='all'||!currentAgenceView)?'active':''}">Toutes les agences</button>
        </div>` : ''}
        <div id="d3-content"></div>
      </div>
    `;
    const content = document.getElementById('d3-content');
    if (isBoss) {
      if (activeTab==='dashboard') content.innerHTML = renderDashboard();
      else if (activeTab==='stats') content.innerHTML = renderStats();
      else if (activeTab==='livraisons') { const liv = filterByScope(data.livraisons); content.innerHTML = totalsBlock(livraisonTotals(liv), p => `<p class="d3-kpi-value">${p.nb}</p><p class="d3-hist">${fmt(p.montant)} F</p>`) + renderLivraisonsTable(liv, true); }
      else if (activeTab==='depenses') content.innerHTML = renderDepenses(true);
      else if (activeTab==='essence') content.innerHTML = renderEssence(true);
      else if (activeTab==='livreurs') content.innerHTML = renderLivreursAdmin();
      else if (activeTab==='comptes') content.innerHTML = renderComptes();
      else if (activeTab==='archives') content.innerHTML = renderArchives();
      else if (activeTab==='audit') content.innerHTML = renderAudit();
    } else {
      if (activeTab==='saisie') content.innerHTML = renderSaisie();
      else if (activeTab==='mes-livraisons') { const liv = data.livraisons.filter(c=>c.secretaireId===user.id); content.innerHTML = totalsBlock(livraisonTotals(liv), p => `<p class="d3-kpi-value">${p.nb}</p><p class="d3-hist">${fmt(p.montant)} F</p>`) + renderLivraisonsTable(liv, false); }
      else if (activeTab==='depenses') content.innerHTML = renderDepenses(false);
      else if (activeTab==='essence') content.innerHTML = renderEssence(false);
      else if (activeTab==='mon-compte') content.innerHTML = renderMonCompte();
    }
    attachEvents();
  }

  function renderLogin(){
    if (loginMode === 'password' && loginTarget) {
      const label = loginTarget.isBoss ? 'Boss' : loginTarget.nom;
      root.innerHTML = `
        <div class="d3-login">
          ${LOGO_URI?`<img src="${LOGO_URI}" alt="Maya Delivery Service" style="width:130px; margin-bottom:6px;">`:'<h1>MAYA SERVICES</h1>'}
          <p class="sub">Mot de passe — ${esc(label)}</p>
          <div class="d3-pass-box">
            <input type="password" id="pass-input" placeholder="Mot de passe" autofocus>
            ${loginError ? `<div class="d3-error">${esc(loginError)}</div>` : ''}
            <button class="d3-btn" id="btn-submit-pass" style="width:100%; margin-top:6px;">Se connecter</button>
            <button class="d3-back" id="btn-back">← Retour</button>
          </div>
        </div>
      `;
      document.getElementById('btn-submit-pass').addEventListener('click', doLogin);
      document.getElementById('pass-input').addEventListener('keydown', e=>{ if (e.key==='Enter') doLogin(); });
      document.getElementById('btn-back').addEventListener('click', ()=>{ loginMode='grid'; loginError=''; render(); });
      return;
    }

    // Need the (public) list of agences/secretaires to show the grid — fetch a lightweight public endpoint
    api('/api/public/roster').then(r => {
      root.innerHTML = `
        <div class="d3-login">
          ${LOGO_URI?`<img src="${LOGO_URI}" alt="Maya Delivery Service" style="width:170px; margin-bottom:10px;">`:'<h1>MAYA SERVICES</h1>'}
          <p class="sub">Choisis ton profil pour accéder au tableau de bord</p>
          ${r.agences.map(a=>`
            <div class="d3-agence-block">
              <div class="d3-agence-title">${esc(a.nom)}</div>
              <div class="d3-profile-grid">
                ${r.secretaires.filter(s=>s.agenceId===a.id).map(s=>`<button class="d3-profile-btn" data-sec="${s.id}" data-nom="${esc(s.nom)}">${esc(s.nom)}${s.locked?' 🔒':''}</button>`).join('')}
              </div>
            </div>
          `).join('')}
          <button class="d3-boss-btn" id="btn-boss">Boss</button>
        </div>
      `;
      root.querySelectorAll('[data-sec]').forEach(btn=>btn.addEventListener('click', ()=>{
        loginTarget = { isBoss:false, secretaireId: btn.dataset.sec, nom: btn.dataset.nom };
        loginMode='password'; loginError=''; render();
      }));
      document.getElementById('btn-boss').addEventListener('click', ()=>{
        loginTarget = { isBoss:true }; loginMode='password'; loginError=''; render();
      });
    }).catch(()=>{ root.innerHTML = '<div class="d3-login"><p class="sub">Impossible de contacter le serveur.</p></div>'; });
  }

  async function doLogin(){
    const val = document.getElementById('pass-input').value;
    try {
      if (loginTarget.isBoss) {
        const r = await api('/api/login', { method:'POST', body: JSON.stringify({ type:'boss', password: val }) });
        user = r.user;
      } else {
        const r = await api('/api/login', { method:'POST', body: JSON.stringify({ type:'secretaire', id: loginTarget.secretaireId, password: val }) });
        user = r.user;
      }
      loginMode='grid'; loginError=''; currentAgenceView = null; activeTab = null;
      await loadState();
    } catch(e) {
      loginError = (e.body && e.body.error) || 'Erreur de connexion.';
      render();
    }
  }

  function renderSaisie(){
    const ag = user.agenceId;
    return `
      <div class="d3-panel" style="max-width:560px;">
        <h3>Nouvelle livraison — ${esc(agenceNom(ag))}</h3>
        ${data.livreurs.filter(l=>l.agenceId===ag).length===0 ? '<p class="d3-empty">Aucun livreur enregistré pour cette agence — demande au Boss d’en ajouter un.</p>' : `
        <form id="form-livraison">
          <div class="d3-row2">
            <div class="d3-field"><label>Expéditeur</label><input required name="expediteur" placeholder="Nom"></div>
            <div class="d3-field"><label>Contact expéditeur</label><input required name="contactExp" placeholder="Téléphone"></div>
          </div>
          <div class="d3-row2">
            <div class="d3-field"><label>Destinataire</label><input required name="destinataire" placeholder="Nom"></div>
            <div class="d3-field"><label>Contact destinataire</label><input required name="contactDest" placeholder="Téléphone"></div>
          </div>
          <div class="d3-field"><label>Nature du colis</label><input required name="natureColis" placeholder="Ex: documents, colis fragile…"></div>
          <div class="d3-row2">
            <div class="d3-field"><label>Lieu de livraison</label><input required name="lieu" placeholder="Adresse / zone"></div>
            <div class="d3-field"><label>Heure de la commande</label><input required type="time" name="heure"></div>
          </div>
          <div class="d3-row2">
            <div class="d3-field"><label>Montant (F)</label><input required type="number" min="0" name="montant" placeholder="0"></div>
            <div class="d3-field"><label>Livreur</label><select required name="livreurId"><option value="" disabled selected>Choisir…</option>${livreurOptions(ag)}</select></div>
          </div>
          <button class="d3-btn" type="submit">Enregistrer la livraison</button>
        </form>`}
      </div>
    `;
  }

  function renderLivraisonsTable(list, isBoss){
    if (list.length===0) return '<div class="d3-panel"><div class="d3-empty">Aucune livraison enregistrée.</div></div>';
    const editForm = (() => {
      if (!editingLivraisonId) return '';
      const c = list.find(x=>x.id===editingLivraisonId) || data.livraisons.find(x=>x.id===editingLivraisonId);
      if (!c) return '';
      return `
        <div class="d3-panel" style="border:1px solid var(--amber);">
          <h3>Modifier la livraison</h3>
          <form id="form-edit-livraison" data-id="${c.id}">
            <div class="d3-row2">
              <div class="d3-field"><label>Expéditeur</label><input required name="expediteur" value="${esc(c.expediteur)}"></div>
              <div class="d3-field"><label>Contact expéditeur</label><input required name="contactExp" value="${esc(c.contactExp||'')}"></div>
            </div>
            <div class="d3-row2">
              <div class="d3-field"><label>Destinataire</label><input required name="destinataire" value="${esc(c.destinataire)}"></div>
              <div class="d3-field"><label>Contact destinataire</label><input required name="contactDest" value="${esc(c.contactDest||'')}"></div>
            </div>
            <div class="d3-field"><label>Nature du colis</label><input required name="natureColis" value="${esc(c.natureColis||'')}"></div>
            <div class="d3-row2">
              <div class="d3-field"><label>Lieu de livraison</label><input required name="lieu" value="${esc(c.lieu||'')}"></div>
              <div class="d3-field"><label>Heure de la commande</label><input required type="time" name="heure" value="${esc(c.heure||'')}"></div>
            </div>
            <div class="d3-row2">
              <div class="d3-field"><label>Montant (F)</label><input required type="number" min="0" name="montant" value="${c.montant}"></div>
              <div class="d3-field"><label>Livreur</label><select required name="livreurId">${livreurOptions(c.agenceId).replace(`value="${c.livreurId}"`, `value="${c.livreurId}" selected`)}</select></div>
            </div>
            <div class="d3-inline-form">
              <button class="d3-btn" type="submit">Enregistrer les modifications</button>
              <button class="d3-btn d3-btn-ghost" type="button" id="btn-cancel-edit">Annuler</button>
            </div>
          </form>
        </div>
      `;
    })();
    const rows = list.map(c=>{
      const l = livreurById(c.livreurId)||{nom:'—'};
      const editable = c.statut!=='livree' && c.statut!=='annulee';
      return `
        <tr>
          <td class="d3-mono">${c.date}${isBoss?' · '+esc(agenceNom(c.agenceId)):''}</td>
          <td class="d3-mono">${esc(c.heure||'—')}</td>
          <td>${esc(c.expediteur)} → ${esc(c.destinataire)}</td>
          <td>${esc(c.natureColis)}</td>
          <td>${esc(c.lieu)}</td>
          <td>${esc(l.nom)}</td>
          <td class="d3-mono">${fmt(c.montant)} F</td>
          <td><span class="d3-badge ${c.statut}">${({attente:'En attente',cours:'En cours',livree:'Livrée',annulee:'Annulée'})[c.statut]}</span>${c.statut==='annulee'?`<div class="d3-hist">Motif: ${esc(c.motifAnnulation||'—')}</div>`:''}</td>
          <td>${editable ? `<button class="d3-btn d3-btn-ghost d3-btn-small" data-action="advance" data-id="${c.id}">→ suite</button>` : ''}
              ${editable ? `<button class="d3-btn d3-btn-ghost d3-btn-small" data-action="edit-liv" data-id="${c.id}">Modifier</button>` : ''}
              ${c.statut!=='annulee' ? `<button class="d3-btn d3-btn-ghost d3-btn-small" data-action="annuler-liv" data-id="${c.id}">Annuler</button>` : ''}</td>
        </tr>
      `;
    }).join('');
    return `
      ${editForm}
      <div class="d3-panel">
        <h3>${isBoss?'Toutes les livraisons':'Mes livraisons'}</h3>
        <table class="d3-table">
          <thead><tr><th>Date</th><th>Heure</th><th>Expéditeur → Destinataire</th><th>Colis</th><th>Lieu</th><th>Livreur</th><th>Montant</th><th>Statut</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderDepenses(isBoss){
    const scope = scopeAgences();
    const list = data.depenses.filter(d=>scope.includes(d.agenceId));
    const rows = list.map(d=>`<tr><td class="d3-mono">${d.date}${isBoss?' · '+esc(agenceNom(d.agenceId)):''}</td><td class="d3-mono">${fmt(d.montant)} F</td><td>${esc(d.note)}</td><td>${d.livreurId?esc((livreurById(d.livreurId)||{}).nom):'—'}</td><td>${d.secretaireId?esc((secretaireById(d.secretaireId)||{}).nom):'Boss'}</td></tr>`).join('');
    const agenceForForm = user.type==='boss' ? (currentAgenceView==='all'||!currentAgenceView ? data.agences[0].id : currentAgenceView) : user.agenceId;
    return totalsBlock(depenseTotals(list), p => `<p class="d3-kpi-value">${fmt(p.montant)} F</p>`) + `
      <div class="d3-grid2">
        <div class="d3-panel">
          <h3>Ajouter une dépense${user.type==='boss'?' — '+esc(agenceNom(agenceForForm)):''}</h3>
          <form id="form-depense">
            <div class="d3-field"><label>Montant (F)</label><input required type="number" min="0" name="montant" placeholder="0"></div>
            <div class="d3-field"><label>Note</label><input required name="note" placeholder="Ex: réparation, forfait appel…"></div>
            <div class="d3-field"><label>Livreur concerné (optionnel)</label><select name="livreurId"><option value="">— Dépense générale —</option>${livreurOptions(agenceForForm)}</select></div>
            <button class="d3-btn" type="submit">Enregistrer</button>
          </form>
        </div>
        <div class="d3-panel">
          <h3>Historique des dépenses</h3>
          ${list.length ? `<table class="d3-table"><thead><tr><th>Date</th><th>Montant</th><th>Note</th><th>Livreur</th><th>Saisi par</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="d3-empty">Aucune dépense enregistrée.</div>'}
        </div>
      </div>
    `;
  }

  function renderEssence(isBoss){
    const scope = scopeAgences();
    const list = data.essence.filter(e=>scope.includes(e.agenceId));
    const agenceForForm = user.type==='boss' ? (currentAgenceView==='all'||!currentAgenceView ? data.agences[0].id : currentAgenceView) : user.agenceId;
    const histForAg = data.prixEssence[agenceForForm] || [];
    const sorted = [...histForAg].sort((a,b)=>a.depuis.localeCompare(b.depuis));
    const prixActuel = sorted.length ? sorted[sorted.length-1].prix : 0;
    const rows = list.map(e=>`<tr><td class="d3-mono">${e.date}${isBoss?' · '+esc(agenceNom(e.agenceId)):''}</td><td>${esc((livreurById(e.livreurId)||{}).nom)}</td><td class="d3-mono">${e.litres} L</td><td class="d3-mono">${e.prixApplique} F/L</td><td class="d3-mono">${fmt(e.coutTotal)} F</td></tr>`).join('');
    return totalsBlock(essenceTotals(list), p => `<p class="d3-kpi-value">${p.litres} L</p><p class="d3-hist">${fmt(p.cout)} F</p>`) + `
      <div class="d3-grid2">
        <div style="display:flex; flex-direction:column; gap:14px;">
          <div class="d3-panel">
            <h3>Enregistrer une consommation</h3>
            <p class="d3-hist" style="margin-bottom:10px;">Prix actuel du litre (${esc(agenceNom(agenceForForm))}) : <strong>${fmt(prixActuel)} F</strong></p>
            ${data.livreurs.filter(l=>l.agenceId===agenceForForm).length===0 ? '<p class="d3-empty">Aucun livreur pour cette agence.</p>' : `
            <form id="form-essence">
              <div class="d3-field"><label>Livreur</label><select required name="livreurId"><option value="" disabled selected>Choisir…</option>${livreurOptions(agenceForForm)}</select></div>
              <div class="d3-field"><label>Nombre de litres</label><input required type="number" min="0" step="0.1" name="litres" placeholder="0"></div>
              <button class="d3-btn" type="submit">Enregistrer</button>
            </form>`}
          </div>
          ${isBoss ? `
          <div class="d3-panel">
            <h3>Prix du litre — ${esc(agenceNom(agenceForForm))}</h3>
            <div class="d3-inline-form">
              <div class="d3-field"><label>Nouveau prix (F/L)</label><input type="number" min="0" id="prix-essence-input"></div>
              <button class="d3-btn d3-btn-small" id="btn-update-prix" data-agence="${agenceForForm}">Mettre à jour</button>
            </div>
            <p class="d3-hist">Un changement de prix ne s'applique qu'aux nouvelles saisies — les anciennes gardent le prix appliqué à l'époque.</p>
          </div>` : ''}
        </div>
        <div class="d3-panel">
          <h3>Historique de consommation</h3>
          ${list.length ? `<table class="d3-table"><thead><tr><th>Date</th><th>Livreur</th><th>Litres</th><th>Prix appliqué</th><th>Coût</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="d3-empty">Aucune consommation enregistrée.</div>'}
        </div>
      </div>
    `;
  }

  function renderLivreursAdmin(){
    const scope = scopeAgences();
    const list = data.livreurs.filter(l=>scope.includes(l.agenceId));
    const agenceForForm = (currentAgenceView==='all'||!currentAgenceView) ? data.agences[0].id : currentAgenceView;
    const rows = list.map(l=>{
      const tauxActuel = l.type==='independant' ? tauxAt(l, data.todayISO) : null;
      return `
      <div class="d3-panel">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
          <div>
            <strong>${esc(l.nom)}</strong> <span class="d3-badge ${l.type}" style="margin-left:6px;">${l.type==='salarie'?'Salarié':'Indépendant'}</span>
            <span class="d3-hist" style="display:inline-block; margin-left:6px;">${esc(agenceNom(l.agenceId))}</span>
            ${l.type==='salarie' ? `<div class="d3-hist">Salaire mensuel : ${fmt(l.salaireMensuel)} F</div>` : `<div class="d3-hist">Taux actuel : ${tauxActuel}%</div>`}
          </div>
          <div class="d3-inline-form">
            ${l.type==='independant' ? `
              <div class="d3-field"><label>Nouveau taux (%)</label><input type="number" min="0" max="100" style="width:90px" id="taux-${l.id}"></div>
              <button class="d3-btn d3-btn-small" data-action="update-taux" data-id="${l.id}">Mettre à jour</button>
            ` : `
              <div class="d3-field"><label>Nouveau salaire (F)</label><input type="number" min="0" style="width:120px" id="salaire-${l.id}"></div>
              <button class="d3-btn d3-btn-small" data-action="update-salaire" data-id="${l.id}">Mettre à jour</button>
            `}
          </div>
        </div>
      </div>
    `;}).join('');
    return `
      <div class="d3-grid2">
        <div class="d3-panel">
          <h3>Ajouter un livreur</h3>
          <form id="form-livreur">
            ${(currentAgenceView==='all'||!currentAgenceView) ? `<div class="d3-field"><label>Agence</label><select name="agenceId">${data.agences.map(a=>`<option value="${a.id}">${esc(a.nom)}</option>`).join('')}</select></div>` : `<input type="hidden" name="agenceId" value="${agenceForForm}">`}
            <div class="d3-field"><label>Nom</label><input required name="nom" placeholder="Ex: Jean"></div>
            <div class="d3-field"><label>Type</label>
              <select name="type" id="type-select" required>
                <option value="salarie">Salarié (moto de l'entreprise)</option>
                <option value="independant">Indépendant (sa propre moto)</option>
              </select>
            </div>
            <div class="d3-field" id="champ-taux"><label>Taux de commission (%)</label><input type="number" min="0" max="100" name="taux" placeholder="Ex: 25"></div>
            <div class="d3-field" id="champ-salaire" style="display:none"><label>Salaire mensuel (F)</label><input type="number" min="0" name="salaire" placeholder="0"></div>
            <button class="d3-btn" type="submit">Ajouter</button>
          </form>
        </div>
        <div>
          <h3 style="font-family:'Space Grotesk',sans-serif; margin-bottom:12px;">Livreurs (${list.length})</h3>
          ${list.length ? rows : '<div class="d3-panel"><div class="d3-empty">Aucun livreur pour le moment.</div></div>'}
        </div>
      </div>
    `;
  }

  function renderComptes(){
    const secRows = data.secretaires.map(s=>`
      <div class="d3-account-row">
        <div><strong>${esc(s.nom)}</strong> <span class="d3-hist">(${esc(agenceNom(s.agenceId))})</span> <span class="d3-badge ${s.locked?'locked':'active-acc'}" style="margin-left:6px;">${s.locked?'Bloqué':'Actif'}</span></div>
        <div class="d3-inline-form">
          ${s.locked ? `<button class="d3-btn d3-btn-small" data-action="unlock" data-id="${s.id}">Débloquer</button>` : ''}
          <input type="password" placeholder="Nouveau mot de passe" id="newpass-${s.id}" style="width:160px; background:var(--bg-deep); border:1px solid var(--line); border-radius:8px; padding:7px; color:var(--text-on-navy);">
          <button class="d3-btn d3-btn-ghost d3-btn-small" data-action="reset-pass" data-id="${s.id}">Changer</button>
        </div>
      </div>
    `).join('');
    return `
      <div class="d3-panel">
        <h3>Comptes secrétaires</h3>
        ${secRows}
      </div>
      <div class="d3-panel">
        <h3>Mon mot de passe (Boss)</h3>
        <div class="d3-inline-form">
          <input type="password" placeholder="Nouveau mot de passe" id="newpass-boss" style="width:200px; background:var(--bg-deep); border:1px solid var(--line); border-radius:8px; padding:7px; color:var(--text-on-navy);">
          <button class="d3-btn d3-btn-small" data-action="reset-pass-boss">Changer</button>
        </div>
        <p class="d3-hist" style="margin-top:8px;">Le compte Boss n'a pas de blocage après 3 essais, puisque personne d'autre ne peut le débloquer.</p>
      </div>
      <div class="d3-panel">
        <h3>Noms des agences</h3>
        ${data.agences.map(a=>`
          <div class="d3-inline-form" style="margin-bottom:10px;">
            <div class="d3-field"><label>${esc(a.nom)}</label><input value="${esc(a.nom)}" id="agence-nom-${a.id}"></div>
            <button class="d3-btn d3-btn-ghost d3-btn-small" data-action="rename-agence" data-id="${a.id}">Renommer</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderMonCompte(){
    return `
      <div class="d3-panel" style="max-width:420px;">
        <h3>Changer mon mot de passe</h3>
        <div class="d3-field"><label>Nouveau mot de passe</label><input type="password" id="my-newpass"></div>
        <button class="d3-btn" id="btn-change-my-pass">Mettre à jour</button>
      </div>
    `;
  }

  function renderAudit(){
    if (!data.audit || data.audit.length===0) return '<div class="d3-panel"><div class="d3-empty">Aucune activité enregistrée.</div></div>';
    return `<div class="d3-panel"><h3>Journal d'activité (le plus récent en premier)</h3>
      ${data.audit.slice(0,150).map(a=>`<div class="d3-audit-item"><div class="d3-audit-time">${new Date(a.timestamp).toLocaleString('fr-FR')} — ${esc(a.who)}${a.agence_id?' · '+esc(agenceNom(a.agence_id)):''}</div><div><strong>${esc(a.action)}</strong> — ${esc(a.detail)}</div></div>`).join('')}
    </div>`;
  }

  function renderArchives(){
    const sub = `<div class="d3-period-toggle">
      <button data-archive-tab="jours" class="${archiveSubTab==='jours'?'active':''}">Jours précédents</button>
      <button data-archive-tab="semaines" class="${archiveSubTab==='semaines'?'active':''}">Semaines précédentes</button>
      <button data-archive-tab="mois" class="${archiveSubTab==='mois'?'active':''}">Mois précédents</button>
    </div>`;
    const view = archiveSubTab==='jours' ? renderArchiveDays() : (archiveSubTab==='semaines' ? renderArchiveWeeks() : renderArchiveMonths());
    return sub + view;
  }

  function renderArchiveDays(){
    const scope = scopeAgences();
    const allLiv = filterByScope(data.livraisons).filter(c=>c.statut!=='annulee');
    const today = data.todayISO;
    const groups = {};
    allLiv.forEach(c=>{ if (c.date !== today) { groups[c.date] = groups[c.date] || []; groups[c.date].push(c); } });
    const keys = Object.keys(groups).sort().reverse();
    if (keys.length===0) return '<div class="d3-panel"><div class="d3-empty">Pas encore de journée archivée.</div></div>';
    return keys.map(k=>{
      const list = groups[k];
      const CA = list.reduce((s,c)=>s+c.montant,0);
      const commissions = list.reduce((s,c)=>{ const l=livreurById(c.livreurId); if(l&&l.type==='independant') return s+c.montant*(tauxAt(l,c.date)/100); return s; },0);
      const depensesP = data.depenses.filter(d=>scope.includes(d.agenceId) && d.date===k).reduce((s,d)=>s+d.montant,0);
      const essenceP = data.essence.filter(e=>scope.includes(e.agenceId) && e.date===k).reduce((s,e)=>s+e.coutTotal,0);
      const expanded = expandedDayKey === k;
      const label = new Date(k+'T00:00:00Z').toLocaleDateString('fr-FR',{weekday:'long', day:'2-digit', month:'long', year:'numeric', timeZone:'UTC'});
      return `
        <div class="d3-panel">
          <h3>${label}</h3>
          <table class="d3-table"><tbody>
            <tr><td>Livraisons</td><td class="d3-mono">${list.length}</td></tr>
            <tr><td>Chiffre d'affaires</td><td class="d3-mono">${fmt(CA)} F</td></tr>
            <tr><td>Commissions indépendants</td><td class="d3-mono">− ${fmt(commissions)} F</td></tr>
            <tr><td>Essence</td><td class="d3-mono">− ${fmt(essenceP)} F</td></tr>
            <tr><td>Dépenses diverses</td><td class="d3-mono">− ${fmt(depensesP)} F</td></tr>
          </tbody></table>
          <button class="d3-btn d3-btn-ghost d3-btn-small" data-action="toggle-day" data-key="${k}" style="margin-top:8px;">${expanded?'Masquer le détail':'Voir le détail des livraisons'}</button>
          ${expanded ? `<div style="margin-top:12px;">${renderLivraisonsTable(list, true)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderArchiveWeeks(){
    const scope = scopeAgences();
    const allLiv = filterByScope(data.livraisons).filter(c=>c.statut!=='annulee');
    const curWeek = semaineKeyLocal(data.todayISO);
    const groups = {};
    allLiv.forEach(c=>{ const wk = semaineKeyLocal(c.date); if (wk !== curWeek) { groups[wk] = groups[wk] || []; groups[wk].push(c); } });
    const keys = Object.keys(groups).sort().reverse();
    if (keys.length===0) return '<div class="d3-panel"><div class="d3-empty">Pas encore de semaine archivée.</div></div>';
    return keys.map(k=>{
      const list = groups[k];
      const r = weekRangeLocal(list[0].date);
      const CA = list.reduce((s,c)=>s+c.montant,0);
      const commissions = list.reduce((s,c)=>{ const l=livreurById(c.livreurId); if(l&&l.type==='independant') return s+c.montant*(tauxAt(l,c.date)/100); return s; },0);
      const depensesP = data.depenses.filter(d=>scope.includes(d.agenceId) && semaineKeyLocal(d.date)===k).reduce((s,d)=>s+d.montant,0);
      const essenceP = data.essence.filter(e=>scope.includes(e.agenceId) && semaineKeyLocal(e.date)===k).reduce((s,e)=>s+e.coutTotal,0);
      const expanded = expandedWeekKey === k;
      return `
        <div class="d3-panel">
          <h3>${r.label}</h3>
          <table class="d3-table"><tbody>
            <tr><td>Livraisons</td><td class="d3-mono">${list.length}</td></tr>
            <tr><td>Chiffre d'affaires</td><td class="d3-mono">${fmt(CA)} F</td></tr>
            <tr><td>Commissions indépendants</td><td class="d3-mono">− ${fmt(commissions)} F</td></tr>
            <tr><td>Essence</td><td class="d3-mono">− ${fmt(essenceP)} F</td></tr>
            <tr><td>Dépenses diverses</td><td class="d3-mono">− ${fmt(depensesP)} F</td></tr>
          </tbody></table>
          <button class="d3-btn d3-btn-ghost d3-btn-small" data-action="toggle-week" data-key="${k}" style="margin-top:8px;">${expanded?'Masquer le détail':'Voir le détail des livraisons'}</button>
          ${expanded ? `<div style="margin-top:12px;">${renderLivraisonsTable(list, true)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderArchiveMonths(){
    const scope = scopeAgences();
    const all = filterByScope(data.livraisons).filter(c=>c.statut!=='annulee');
    const keys = {};
    all.forEach(c=>{ const r = moisRangeLocal(c.date); if (r.key !== data.currentMoisKey) { keys[r.key] = keys[r.key] || { label:r.label, courses:[] }; keys[r.key].courses.push(c); } });
    const sortedKeys = Object.keys(keys).sort().reverse();
    if (sortedKeys.length===0) return '<div class="d3-panel"><div class="d3-empty">Pas encore de mois archivé.</div></div>';
    return sortedKeys.map(k=>{
      const grp = keys[k];
      const CA = grp.courses.reduce((s,c)=>s+c.montant,0);
      const commissions = grp.courses.reduce((s,c)=>{ const l=livreurById(c.livreurId); if(l&&l.type==='independant') return s+c.montant*(tauxAt(l,c.date)/100); return s; },0);
      const salaires = data.livreurs.filter(l=>scope.includes(l.agenceId) && l.type==='salarie').reduce((s,l)=>s+(l.salaireMensuel||0),0);
      const depensesP = data.depenses.filter(d=>scope.includes(d.agenceId) && moisRangeLocal(d.date).key===k).reduce((s,d)=>s+d.montant,0);
      const essenceP = data.essence.filter(e=>scope.includes(e.agenceId) && moisRangeLocal(e.date).key===k).reduce((s,e)=>s+e.coutTotal,0);
      const marge = CA - commissions - salaires - depensesP - essenceP;
      return `
        <div class="d3-panel">
          <h3>${grp.label}</h3>
          <table class="d3-table"><tbody>
            <tr><td>Chiffre d'affaires</td><td class="d3-mono">${fmt(CA)} F</td></tr>
            <tr><td>Commissions indépendants</td><td class="d3-mono">− ${fmt(commissions)} F</td></tr>
            <tr><td>Salaires</td><td class="d3-mono">− ${fmt(salaires)} F</td></tr>
            <tr><td>Essence</td><td class="d3-mono">− ${fmt(essenceP)} F</td></tr>
            <tr><td>Dépenses diverses</td><td class="d3-mono">− ${fmt(depensesP)} F</td></tr>
            <tr><td><strong>Marge nette</strong></td><td class="d3-mono"><strong>${fmt(marge)} F</strong></td></tr>
          </tbody></table>
        </div>
      `;
    }).join('');
  }

  function renderDashboard(){
    const scope = scopeAgences();
    const moisLiv = filterByScope(data.livraisons).filter(c=>c.statut!=='annulee' && moisRangeLocal(c.date).key===data.currentMoisKey);
    const CA = moisLiv.reduce((s,c)=>s+c.montant,0);
    const commissions = moisLiv.reduce((s,c)=>{ const l=livreurById(c.livreurId); if(l&&l.type==='independant') return s+c.montant*(tauxAt(l,c.date)/100); return s; },0);
    const salaires = data.livreurs.filter(l=>scope.includes(l.agenceId) && l.type==='salarie').reduce((s,l)=>s+(l.salaireMensuel||0),0);
    const depensesMois = data.depenses.filter(d=>scope.includes(d.agenceId) && moisRangeLocal(d.date).key===data.currentMoisKey).reduce((s,d)=>s+d.montant,0);
    const essenceMois = data.essence.filter(e=>scope.includes(e.agenceId) && moisRangeLocal(e.date).key===data.currentMoisKey).reduce((s,e)=>s+e.coutTotal,0);
    const marge = CA - commissions - salaires - depensesMois - essenceMois;
    const nbJour = filterByScope(data.livraisons).filter(c=>c.statut!=='annulee' && isSamePeriod(c.date,'jour')).length;
    return `
      <p class="d3-hist" style="margin-bottom:14px;">Mois en cours : ${moisRangeLocal(data.todayISO).label}</p>
      <div class="d3-kpi-row">
        <div class="d3-kpi"><p class="d3-kpi-label">Livraisons aujourd'hui</p><p class="d3-kpi-value">${nbJour}</p></div>
        <div class="d3-kpi amber"><p class="d3-kpi-label">CA du mois</p><p class="d3-kpi-value">${fmt(CA)} F</p></div>
        <div class="d3-kpi"><p class="d3-kpi-label">Essence du mois</p><p class="d3-kpi-value">${fmt(essenceMois)} F</p></div>
        <div class="d3-kpi"><p class="d3-kpi-label">Dépenses du mois</p><p class="d3-kpi-value">${fmt(depensesMois)} F</p></div>
        <div class="d3-kpi ${marge>=0?'teal':'coral'}"><p class="d3-kpi-label">Marge nette</p><p class="d3-kpi-value">${fmt(marge)} F</p></div>
      </div>
      <div class="d3-panel">
        <h3>Détail du mois</h3>
        <table class="d3-table"><tbody>
          <tr><td>Chiffre d'affaires</td><td class="d3-mono">${fmt(CA)} F</td></tr>
          <tr><td>Commissions indépendants</td><td class="d3-mono">− ${fmt(commissions)} F</td></tr>
          <tr><td>Salaires</td><td class="d3-mono">− ${fmt(salaires)} F</td></tr>
          <tr><td>Essence</td><td class="d3-mono">− ${fmt(essenceMois)} F</td></tr>
          <tr><td>Dépenses diverses</td><td class="d3-mono">− ${fmt(depensesMois)} F</td></tr>
        </tbody></table>
      </div>
      <p class="d3-note">Le mois se termine et recommence automatiquement le 5 de chaque mois.</p>
    `;
  }

  function renderStats(){
    const scope = scopeAgences();
    const rows = data.livreurs.filter(l=>scope.includes(l.agenceId)).map(l=>{
      const valid = data.livraisons.filter(c=>c.livreurId===l.id && c.statut!=='annulee' && isSamePeriod(c.date, period));
      const nb = valid.length;
      const montantTotal = valid.reduce((s,c)=>s+c.montant,0);
      const part = l.type==='independant' ? valid.reduce((s,c)=>s+c.montant*(tauxAt(l,c.date)/100),0) : null;
      return { l, nb, montantTotal, part };
    });
    return `
      <div class="d3-period-toggle">
        <button data-period="jour" class="${period==='jour'?'active':''}">Aujourd'hui</button>
        <button data-period="semaine" class="${period==='semaine'?'active':''}">Cette semaine</button>
        <button data-period="mois" class="${period==='mois'?'active':''}">Ce mois</button>
      </div>
      <div class="d3-panel">
        <table class="d3-table">
          <thead><tr><th>Livreur</th><th>Agence</th><th>Type</th><th>Livraisons</th><th>Montant total</th><th>Part / salaire</th></tr></thead>
          <tbody>
            ${rows.length ? rows.map(r=>`
              <tr>
                <td>${esc(r.l.nom)}</td>
                <td>${esc(agenceNom(r.l.agenceId))}</td>
                <td><span class="d3-badge ${r.l.type}">${r.l.type==='salarie'?'Salarié':'Indépendant'}</span></td>
                <td>${r.nb}</td>
                <td class="d3-mono">${fmt(r.montantTotal)} F</td>
                <td class="d3-mono">${r.part===null ? fmt(r.l.salaireMensuel)+' F (fixe)' : fmt(r.part)+' F'}</td>
              </tr>
            `).join('') : `<tr><td colspan="6" class="d3-empty">Aucun livreur.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }

  function attachEvents(){
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', async ()=>{ try{ await api('/api/logout',{method:'POST'});}catch(e){} user=null; data=null; loaded=false; currentAgenceView=null; stopPoll(); render(); });

    root.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click', ()=>{ activeTab=b.dataset.tab; render(); }));
    root.querySelectorAll('[data-agence-view]').forEach(b=>b.addEventListener('click', ()=>{ currentAgenceView=b.dataset.agenceView; loadState(); }));
    root.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click', ()=>{ period=b.dataset.period; render(); }));
    root.querySelectorAll('[data-archive-tab]').forEach(b=>b.addEventListener('click', ()=>{ archiveSubTab=b.dataset.archiveTab; expandedWeekKey=null; expandedDayKey=null; render(); }));
    root.querySelectorAll('[data-action="toggle-week"]').forEach(b=>b.addEventListener('click', ()=>{ expandedWeekKey = (expandedWeekKey===b.dataset.key) ? null : b.dataset.key; render(); }));
    root.querySelectorAll('[data-action="toggle-day"]').forEach(b=>b.addEventListener('click', ()=>{ expandedDayKey = (expandedDayKey===b.dataset.key) ? null : b.dataset.key; render(); }));

    const formLiv = document.getElementById('form-livraison');
    if (formLiv) formLiv.addEventListener('submit', async e=>{
      e.preventDefault(); const fd=new FormData(formLiv);
      try {
        await api('/api/livraisons', { method:'POST', body: JSON.stringify({
          expediteur:fd.get('expediteur'), contactExp:fd.get('contactExp'), destinataire:fd.get('destinataire'), contactDest:fd.get('contactDest'),
          natureColis:fd.get('natureColis'), lieu:fd.get('lieu'), heure:fd.get('heure'), montant:Number(fd.get('montant'))||0, livreurId:fd.get('livreurId')
        })});
        formLiv.reset(); await loadState();
      } catch(err){ alert(err.message); }
    });

    const formDep = document.getElementById('form-depense');
    if (formDep) formDep.addEventListener('submit', async e=>{
      e.preventDefault(); const fd=new FormData(formDep);
      const ag = user.type==='boss' ? (currentAgenceView==='all'||!currentAgenceView?data.agences[0].id:currentAgenceView) : user.agenceId;
      try { await api('/api/depenses', { method:'POST', body: JSON.stringify({ agenceId:ag, montant:fd.get('montant'), note:fd.get('note'), livreurId:fd.get('livreurId')||null })}); formDep.reset(); await loadState(); }
      catch(err){ alert(err.message); }
    });

    const formEss = document.getElementById('form-essence');
    if (formEss) formEss.addEventListener('submit', async e=>{
      e.preventDefault(); const fd=new FormData(formEss);
      const ag = user.type==='boss' ? (currentAgenceView==='all'||!currentAgenceView?data.agences[0].id:currentAgenceView) : user.agenceId;
      try { await api('/api/essence', { method:'POST', body: JSON.stringify({ agenceId:ag, livreurId:fd.get('livreurId'), litres:fd.get('litres') })}); formEss.reset(); await loadState(); }
      catch(err){ alert(err.message); }
    });

    const btnPrix = document.getElementById('btn-update-prix');
    if (btnPrix) btnPrix.addEventListener('click', async ()=>{
      const v = document.getElementById('prix-essence-input').value;
      if (v !== '') { try { await api('/api/prix-essence', { method:'POST', body: JSON.stringify({ agenceId: btnPrix.dataset.agence, prix: v })}); await loadState(); } catch(err){ alert(err.message); } }
    });

    const formLivreur = document.getElementById('form-livreur');
    if (formLivreur) {
      const typeSelect = document.getElementById('type-select');
      typeSelect.addEventListener('change', ()=>{
        document.getElementById('champ-taux').style.display = typeSelect.value==='independant'?'block':'none';
        document.getElementById('champ-salaire').style.display = typeSelect.value==='salarie'?'block':'none';
      });
      formLivreur.addEventListener('submit', async e=>{
        e.preventDefault(); const fd=new FormData(formLivreur);
        const ag = fd.get('agenceId') || (currentAgenceView==='all'||!currentAgenceView?data.agences[0].id:currentAgenceView);
        try { await api('/api/livreurs', { method:'POST', body: JSON.stringify({ agenceId:ag, nom:fd.get('nom'), type:fd.get('type'), taux:fd.get('taux'), salaire:fd.get('salaire') })}); formLivreur.reset(); await loadState(); }
        catch(err){ alert(err.message); }
      });
    }

    root.querySelectorAll('[data-action="update-taux"]').forEach(b=>b.addEventListener('click', async ()=>{ const i=document.getElementById('taux-'+b.dataset.id); if(i.value!=='') { try { await api('/api/livreurs/'+b.dataset.id+'/taux', {method:'POST', body: JSON.stringify({taux:i.value})}); await loadState(); } catch(err){ alert(err.message); } } }));
    root.querySelectorAll('[data-action="update-salaire"]').forEach(b=>b.addEventListener('click', async ()=>{ const i=document.getElementById('salaire-'+b.dataset.id); if(i.value!=='') { try { await api('/api/livreurs/'+b.dataset.id+'/salaire', {method:'POST', body: JSON.stringify({salaire:i.value})}); await loadState(); } catch(err){ alert(err.message); } } }));
    root.querySelectorAll('[data-action="advance"]').forEach(b=>b.addEventListener('click', async ()=>{ try { await api('/api/livraisons/'+b.dataset.id+'/advance', {method:'POST', body:'{}'}); await loadState(); } catch(err){ alert(err.message); } }));
    root.querySelectorAll('[data-action="edit-liv"]').forEach(b=>b.addEventListener('click', ()=>{ editingLivraisonId = b.dataset.id; render(); }));
    const btnCancelEdit = document.getElementById('btn-cancel-edit');
    if (btnCancelEdit) btnCancelEdit.addEventListener('click', ()=>{ editingLivraisonId = null; render(); });
    const formEditLiv = document.getElementById('form-edit-livraison');
    if (formEditLiv) formEditLiv.addEventListener('submit', async e=>{
      e.preventDefault(); const fd = new FormData(formEditLiv);
      try {
        await api('/api/livraisons/'+formEditLiv.dataset.id+'/edit', { method:'POST', body: JSON.stringify({
          expediteur:fd.get('expediteur'), contactExp:fd.get('contactExp'), destinataire:fd.get('destinataire'), contactDest:fd.get('contactDest'),
          natureColis:fd.get('natureColis'), lieu:fd.get('lieu'), heure:fd.get('heure'), montant:Number(fd.get('montant'))||0, livreurId:fd.get('livreurId')
        })});
        editingLivraisonId = null; await loadState();
      } catch(err){ alert(err.message); }
    });
    root.querySelectorAll('[data-action="annuler-liv"]').forEach(b=>b.addEventListener('click', async ()=>{ const motif=prompt('Motif de l’annulation :'); if (motif) { try { await api('/api/livraisons/'+b.dataset.id+'/cancel', {method:'POST', body: JSON.stringify({motif})}); await loadState(); } catch(err){ alert(err.message); } } }));

    root.querySelectorAll('[data-action="unlock"]').forEach(b=>b.addEventListener('click', async ()=>{ try { await api('/api/comptes/'+b.dataset.id+'/unlock', {method:'POST', body:'{}'}); await loadState(); } catch(err){ alert(err.message); } }));
    root.querySelectorAll('[data-action="reset-pass"]').forEach(b=>b.addEventListener('click', async ()=>{ const i=document.getElementById('newpass-'+b.dataset.id); if(i.value){ try { await api('/api/comptes/'+b.dataset.id+'/password', {method:'POST', body: JSON.stringify({newPassword:i.value})}); alert('Mot de passe modifié.'); i.value=''; } catch(err){ alert(err.message); } } }));
    const resetBoss = document.querySelector('[data-action="reset-pass-boss"]');
    if (resetBoss) resetBoss.addEventListener('click', async ()=>{ const i=document.getElementById('newpass-boss'); if(i.value){ try { await api('/api/account/password', {method:'POST', body: JSON.stringify({newPassword:i.value})}); alert('Mot de passe modifié.'); i.value=''; } catch(err){ alert(err.message); } } });
    root.querySelectorAll('[data-action="rename-agence"]').forEach(b=>b.addEventListener('click', async ()=>{ const i=document.getElementById('agence-nom-'+b.dataset.id); if(i.value){ try { await api('/api/agences/'+b.dataset.id+'/rename', {method:'POST', body: JSON.stringify({nom:i.value})}); await loadState(); } catch(err){ alert(err.message); } } }));

    const btnMyPass = document.getElementById('btn-change-my-pass');
    if (btnMyPass) btnMyPass.addEventListener('click', async ()=>{ const i=document.getElementById('my-newpass'); if(i.value){ try { await api('/api/account/password', {method:'POST', body: JSON.stringify({newPassword:i.value})}); alert('Mot de passe modifié.'); i.value=''; } catch(err){ alert(err.message); } } });

    if (user && user.type==='boss') startPoll(); else stopPoll();
  }

  function startPoll(){
    stopPoll();
    pollTimer = setInterval(()=>{
      const active = document.activeElement;
      if (active && ['INPUT','SELECT','TEXTAREA'].includes(active.tagName)) return;
      loadState();
    }, 6000);
  }
  function stopPoll(){ if (pollTimer) { clearInterval(pollTimer); pollTimer=null; } }

  (async function init(){
    await loadLogo();
    await checkSession();
    if (user) await loadState(); else render();
  })();
})();
