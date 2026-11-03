/**
 * BIBLIO-PROSPECT — Planificateur de tournées
 *
 * Une tournée = une liste ordonnée d'étapes (clients et prospects) à visiter en voiture depuis un point de
 * départ. Enregistrée dans la collection « tournees » de la sauvegarde (js/suivi.js), jamais effacée : une
 * tournée supprimée est seulement marquée « supprime ».
 *
 * Les trois fonctions de calcul (haversineKm, optimiserOrdre, liensGoogleMaps) sont pures et testables
 * sous Node (voir la fin du fichier). Tout le reste touche à la page et n'est appelé que par des actions.
 */

// ---------- Réglages ----------
const PLAN_TOURNEES = {
  coefRoute: 1.3,          // distance par la route ≈ distance à vol d'oiseau × 1,3
  vitesseKmh: 60,          // vitesse moyenne pour la durée estimée
  arretsParLien: 9,        // étapes couvertes par un lien Google Maps (la limite de Google est de 9 points intermédiaires)
  cleDepart: 'biblio_depart_tournee',
  departParDefaut: { libelle: 'Clohars-Carnoët', lat: 47.7733, lon: -3.5953 }, // si le géocodage échoue
  // état de la vue
  id: null, carte: null, rayon: 20, recherche: '', suggestions: [], resultats: [], departMemo: null,
  file: Promise.resolve()  // les ajouts à la tournée se font l'un après l'autre
};

// =====================================================================================================
// Fonctions pures (aucun accès à la page)
// =====================================================================================================

function trNum(v) { return (v === null || v === undefined || v === '') ? NaN : Number(v); }
function trValide(p) { return !!p && Number.isFinite(trNum(p.lat)) && Number.isFinite(trNum(p.lon)); }

// Distance à vol d'oiseau en km entre deux points { lat, lon }
function haversineKm(a, b) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (trNum(b.lat) - trNum(a.lat)) * rad;
  const dLon = (trNum(b.lon) - trNum(a.lon)) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(trNum(a.lat) * rad) * Math.cos(trNum(b.lat) * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ordre de visite conseillé : plus proche voisin depuis le départ, puis amélioration « 2-opt »
 * (on inverse des tronçons tant que cela raccourcit le trajet). Renvoie les indices de `points`
 * dans l'ordre. `retour` : le trajet revient au départ.
 */
function optimiserOrdre(depart, points, retour) {
  const pts = Array.isArray(points) ? points : [];
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const noeuds = [depart || pts[0]].concat(pts); // noeud 0 = départ, noeud k = points[k-1]
  const dist = [];
  for (let i = 0; i <= n; i++) {
    dist.push([]);
    for (let j = 0; j <= n; j++) dist[i].push(i === j ? 0 : haversineKm(noeuds[i], noeuds[j]));
  }
  // 1. plus proche voisin
  const seq = [0];
  const vu = new Array(n + 1).fill(false);
  vu[0] = true;
  for (let k = 0; k < n; k++) {
    const cur = seq[seq.length - 1];
    let best = -1;
    for (let j = 1; j <= n; j++) if (!vu[j] && (best < 0 || dist[cur][j] < dist[cur][best])) best = j;
    vu[best] = true;
    seq.push(best);
  }
  // 2. 2-opt : on inverse seq[i..j] si cela raccourcit le trajet (le départ, en position 0, ne bouge pas)
  let ameliore = true, passes = 0;
  while (ameliore && passes++ < 200) {
    ameliore = false;
    for (let i = 1; i < n; i++) {
      for (let j = i + 1; j <= n; j++) {
        const avant = seq[i - 1];
        const apres = j + 1 <= n ? seq[j + 1] : (retour ? 0 : -1);
        let delta = dist[avant][seq[j]] - dist[avant][seq[i]];
        if (apres >= 0) delta += dist[seq[i]][apres] - dist[seq[j]][apres];
        if (delta < -1e-9) {
          for (let a = i, b = j; a < b; a++, b--) { const x = seq[a]; seq[a] = seq[b]; seq[b] = x; }
          ameliore = true;
        }
      }
    }
  }
  return seq.slice(1).map(k => k - 1);
}

/**
 * Liens Google Maps de l'itinéraire départ → étapes (→ départ si `retour`). Google limite le nombre de points
 * par lien : on découpe en parties de `arretsParLien` étapes ; chaque partie commence là où finit la précédente.
 * Renvoie [{ url, label, de, a, retour }] (de/a : numéros des étapes couvertes).
 */
function liensGoogleMaps(depart, points, retour) {
  const pts = (Array.isArray(points) ? points : []).filter(trValide);
  if (!pts.length) return [];
  const dep = trValide(depart) ? depart : pts[0];
  const n = pts.length;
  const noeuds = [dep].concat(pts);
  if (retour && trValide(depart)) noeuds.push(dep);
  const ll = p => `${trNum(p.lat).toFixed(6)},${trNum(p.lon).toFixed(6)}`;
  const taille = PLAN_TOURNEES.arretsParLien;
  const liens = [];
  for (let debut = 0; debut < noeuds.length - 1; debut += taille) {
    const fin = Math.min(debut + taille, noeuds.length - 1);
    const inter = noeuds.slice(debut + 1, fin).map(ll);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${ll(noeuds[debut])}&destination=${ll(noeuds[fin])}`;
    if (inter.length) url += `&waypoints=${inter.join('|')}`;
    url += '&travelmode=driving';
    const de = debut + 1, a = Math.min(fin, n);
    const avecRetour = fin > n;
    let label;
    if (de > n) label = 'retour au départ';
    else label = `étape${a > de ? 's' : ''} ${a > de ? `${de} à ${a}` : de}${avecRetour ? ', puis retour au départ' : ''}`;
    liens.push({ url, label: '', de, a, retour: avecRetour, detail: label });
  }
  liens.forEach((l, i) => { l.label = `Partie ${i + 1} (${l.detail})`; delete l.detail; });
  return liens;
}

// =====================================================================================================
// Données : lecture et écriture de la collection « tournees »
// =====================================================================================================

function trEsc(s) { return escapeHtml(s); }
function trClone(o) { return JSON.parse(JSON.stringify(o)); }
function trNorm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function trPluriel(n, mot) { return `${n} ${mot}${n > 1 ? 's' : ''}`; }
function trDateOk(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || ''); }
function trDateFr(d) { return trDateOk(d) ? formatDateFr(d) : ''; }

function trCollection() {
  try { return Suivi.collection('tournees') || {}; } catch (e) { return {}; }
}
function trActives() {
  return Object.values(trCollection()).filter(t => t && !t.supprime && t.id);
}
// Tri du sélecteur : par date prévue (à défaut, date de création), la plus récente d'abord
function trTri(a, b) {
  const cle = t => (trDateOk(t.date) ? t.date : (t.cree_le || '').slice(0, 10));
  return cle(b).localeCompare(cle(a)) || (b.cree_le || '').localeCompare(a.cree_le || '');
}
// « Tournée en préparation » : la plus récemment créée, non supprimée, au statut « preparation »
function trEnPreparation() {
  return trActives().filter(t => t.statut === 'preparation').sort((a, b) => (b.cree_le || '').localeCompare(a.cree_le || ''))[0] || null;
}
// Tournée affichée : celle choisie, sinon celle en préparation, sinon la plus récente
function trCourante() {
  const col = trCollection();
  let t = PLAN_TOURNEES.id && col[PLAN_TOURNEES.id];
  if (!t || t.supprime) t = trEnPreparation() || trActives().sort(trTri)[0] || null;
  PLAN_TOURNEES.id = t ? t.id : null;
  return t;
}
function trEnregistrer(t) {
  let ok = false;
  try { ok = Suivi.put('tournees', t.id, t) !== false; } catch (e) { ok = false; }
  if (!ok) showToast("Enregistrement impossible : la tournée n'a pas été sauvegardée.");
  return ok;
}
// Modifie une copie de la tournée affichée, l'enregistre, puis réaffiche
function trModifier(fn, sansAffichage) {
  const cur = trCourante();
  if (!cur) return null;
  const t = trClone(cur);
  if (!Array.isArray(t.etapes)) t.etapes = [];
  const r = fn(t);
  if (r === false) return null;
  trEnregistrer(t);
  if (!sansAffichage) renderTourneesView();
  return t;
}

// ---------- Point de départ ----------
function trLireDepart() {
  try {
    const j = JSON.parse(localStorage.getItem(PLAN_TOURNEES.cleDepart));
    if (j && trValide(j)) return { libelle: String(j.libelle || 'Départ'), lat: trNum(j.lat), lon: trNum(j.lon) };
  } catch (e) { /* stockage indisponible : on ignore */ }
  return null;
}
function trMemoriserDepart(d) {
  try { localStorage.setItem(PLAN_TOURNEES.cleDepart, JSON.stringify({ libelle: d.libelle, lat: d.lat, lon: d.lon })); } catch (e) { /* ignoré */ }
}
// Dernier départ utilisé ; à défaut Clohars-Carnoët (géocodé une seule fois)
async function trDepartParDefaut() {
  const m = trLireDepart();
  if (m) return m;
  if (PLAN_TOURNEES.departMemo) return { ...PLAN_TOURNEES.departMemo };
  let g = null;
  try { g = await geocoderAdresse('', '29360', 'Clohars-Carnoët'); } catch (e) { g = null; }
  if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
    const d = { libelle: 'Clohars-Carnoët', lat: g.latitude, lon: g.longitude };
    PLAN_TOURNEES.departMemo = d;
    trMemoriserDepart(d);
    return { ...d };
  }
  return { ...PLAN_TOURNEES.departParDefaut };
}

async function trCreerTournee() {
  const depart = await trDepartParDefaut();
  const t = {
    nom: 'Tournée du ' + formatDateFr(today()), date: today(), statut: 'preparation',
    depart, retour_au_depart: true, duree_visite_min: 30, etapes: [], cree_le: new Date().toISOString()
  };
  const id = 'tr-' + Date.now().toString(36);
  t.id = id;
  trEnregistrer(t);
  PLAN_TOURNEES.id = id;
  return t;
}

// ---------- Librairies et clients ----------
function trLib(id) {
  try { return (state.bookstores || []).find(b => b.id === id) || (state.baseById && state.baseById.get(id)) || null; } catch (e) { return null; }
}
function trPdv(id) {
  try { const p = Suivi.collection('pdv')[id]; return p && !p.supprime ? p : null; } catch (e) { return null; }
}
function trTelephone(e) {
  if (e.type === 'pdv') {
    const p = trPdv(e.ref);
    const lib = p && p.librairie_id ? trLib(p.librairie_id) : null;
    return safeTel(p && p.telephone) || safeTel(lib && lib.telephone);
  }
  const b = trLib(e.ref);
  return safeTel(b && b.telephone);
}
function trAdresse(e) {
  let a, cp, ville;
  if (e.type === 'pdv') {
    const p = trPdv(e.ref) || {};
    a = p.adresse; cp = p.code_postal; ville = p.ville;
    const lib = p.librairie_id ? trLib(p.librairie_id) : null;
    if (!a && lib) { a = lib.adresse; cp = cp || lib.code_postal; ville = ville || lib.commune; }
  } else {
    const b = trLib(e.ref) || {};
    a = b.adresse; cp = b.code_postal; ville = b.commune;
  }
  ville = ville || e.commune;
  return [a, [cp, ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

// ---------- Calculs de la tournée ----------
function trDepartPoint(t) { return t && trValide(t.depart) ? { lat: trNum(t.depart.lat), lon: trNum(t.depart.lon) } : null; }
function trPointsEtapes(etapes) { return (etapes || []).filter(trValide).map(e => ({ lat: trNum(e.lat), lon: trNum(e.lon) })); }
// Distance estimée par la route (km) : vol d'oiseau × 1,3
function trKm(depart, etapes, retour) {
  const pts = trPointsEtapes(etapes);
  if (!pts.length) return 0;
  let total = 0, prev = depart || pts[0];
  for (const p of pts) { total += haversineKm(prev, p); prev = p; }
  if (retour && depart) total += haversineKm(prev, depart);
  return total * PLAN_TOURNEES.coefRoute;
}
function trMinutes(km, nbEtapes, dureeVisite) {
  return Math.round(km / PLAN_TOURNEES.vitesseKmh * 60 + nbEtapes * (dureeVisite || 0));
}
function trDuree(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

// =====================================================================================================
// Ajouter une étape (appelé depuis les fiches et depuis la vue)
// =====================================================================================================

async function ajouterATournee(type, ref, idTournee) {
  const run = PLAN_TOURNEES.file.then(() => trAjouter(type, ref, idTournee));
  PLAN_TOURNEES.file = run.catch(() => {});
  return run;
}

async function trAjouter(type, ref, idTournee) {
  try {
    if (type === 'lib') {
      ref = Number(ref);
      if (!trLib(ref)) { showToast('Librairie introuvable.'); return null; }
      const client = estClient(ref);
      if (client) { type = 'pdv'; ref = client.id; } // une librairie cliente est suivie comme client
    }
    if (type !== 'lib' && type !== 'pdv') return null;
    const cible = idTournee ? trCollection()[idTournee] : null;
    const dejaDans = t => t && (t.etapes || []).some(e => (e.type === type && String(e.ref) === String(ref))
      || (type === 'pdv' && e.type === 'lib' && trPdv(ref) && e.ref === trPdv(ref).librairie_id));
    const t0 = (cible && !cible.supprime) ? cible : trEnPreparation();
    if (dejaDans(t0)) { showToast(`Déjà dans la tournée « ${t0.nom} ».`); return t0; }

    // Coordonnées de l'étape
    let etape = null;
    if (type === 'lib') {
      const b = trLib(ref);
      etape = { type, ref, nom: b.nom || '', commune: b.commune || '', lat: trNum(b.latitude), lon: trNum(b.longitude), precis: b.localisation === 'adresse' };
      if (!trValide(etape)) {
        const g = await geocoderAdresse(b.adresse, b.code_postal, b.commune);
        if (!g) { showToast("Adresse de la librairie introuvable : complétez-la dans sa fiche."); return null; }
        Object.assign(etape, { lat: g.latitude, lon: g.longitude, precis: !!b.adresse });
      }
    } else {
      const p = trPdv(ref);
      if (!p) { showToast('Client introuvable.'); return null; }
      const b = p.librairie_id ? trLib(p.librairie_id) : null;
      etape = { type, ref, nom: p.nom || (b && b.nom) || '', commune: p.ville || (b && b.commune) || '' };
      if (b && Number.isFinite(trNum(b.latitude)) && Number.isFinite(trNum(b.longitude))) {
        Object.assign(etape, { lat: trNum(b.latitude), lon: trNum(b.longitude), precis: b.localisation === 'adresse' });
      } else {
        const g = await geocoderAdresse(p.adresse, p.code_postal, p.ville);
        if (!g) { showToast('Adresse du client introuvable : complétez-la dans sa fiche'); return null; }
        Object.assign(etape, { lat: g.latitude, lon: g.longitude, precis: !!p.adresse });
      }
    }
    Object.assign(etape, { fait: false, fait_le: '', mvt: '' });

    // Tournée de destination (relue après l'attente du géocodage)
    let t = (idTournee && trCollection()[idTournee] && !trCollection()[idTournee].supprime) ? trCollection()[idTournee] : trEnPreparation();
    if (!t) t = await trCreerTournee();
    if (dejaDans(t)) { showToast(`Déjà dans la tournée « ${t.nom} ».`); return t; }
    const copie = trClone(t);
    if (!Array.isArray(copie.etapes)) copie.etapes = [];
    copie.etapes.push(etape);
    if (!trEnregistrer(copie)) return null;
    PLAN_TOURNEES.id = copie.id;
    showToast(`Ajouté à la tournée « ${copie.nom} » (${trPluriel(copie.etapes.length, 'étape')})`);
    if (typeof state !== 'undefined' && state.activeView === 'tournees') renderTourneesView();
    return copie;
  } catch (e) {
    showToast("L'ajout à la tournée a échoué. Vérifiez votre connexion et réessayez.");
    return null;
  }
}

// =====================================================================================================
// La vue
// =====================================================================================================

function trAlertes(e, gestion) {
  if (e.type !== 'pdv' || !gestion || !gestion.parPdv) return [];
  const f = gestion.parPdv.get(e.ref);
  return f ? (f.raisons || []).filter(r => r.type !== 'contact') : [];
}
function trCourt(s, max) { s = String(s || ''); return s.length > max ? s.slice(0, max - 1).trim() + '…' : s; }

function trLigneEtape(t, e, i, gestion) {
  const tel = trTelephone(e);
  const adresse = trAdresse(e);
  const alertes = trAlertes(e, gestion);
  const existe = e.type === 'pdv' ? !!trPdv(e.ref) : !!trLib(e.ref);
  const n = t.etapes.length;
  return `
    <li class="tr-etape ${e.fait ? 'tr-fait' : ''}">
      <span class="tr-num">${i + 1}</span>
      <div class="tr-etape-main">
        <div>
          ${existe ? `<a href="#" class="tr-nom" onclick="PLAN_TOURNEES_ACTIONS.ouvrir(${i}); return false;" title="Ouvrir la fiche"><strong>${trEsc(e.nom || '(sans nom)')}</strong></a>` : `<strong>${trEsc(e.nom || '(sans nom)')}</strong>`}
          <span class="tr-badge ${e.type === 'pdv' ? 'tr-badge-client' : 'tr-badge-prospect'}">${e.type === 'pdv' ? 'Client' : 'Prospect'}</span>
          ${e.fait ? `<span class="tr-badge tr-badge-fait">Visité${e.fait_le ? ' le ' + trEsc(trDateFr(e.fait_le)) : ''}</span>` : ''}
        </div>
        <div class="g-muted">${trEsc(adresse || e.commune || '')}${e.precis ? '' : ' <span title="Adresse exacte inconnue : l\'étape est placée au centre de la commune">(position approximative)</span>'}</div>
        ${alertes.slice(0, 2).map(r => `<span class="g-raison g-raison-${trEsc(r.type)}">${trEsc(trCourt(r.texte, 110))}</span>`).join('')}
        ${alertes.length > 2 ? `<span class="g-muted">… et ${alertes.length - 2} autre(s) alerte(s) dans la fiche</span>` : ''}
        ${tel ? `<a class="tr-tel" href="tel:${trEsc(tel)}">📞 ${trEsc(tel)}</a>` : ''}
      </div>
      <div class="tr-etape-actions">
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.deplacer(${i}, -1)" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.deplacer(${i}, 1)" title="Descendre" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.retirer(${i})" title="Retirer de la tournée">✕</button>
        <button class="btn ${e.fait ? 'btn-secondary' : 'btn-primary'} btn-sm" onclick="PLAN_TOURNEES_ACTIONS.visite(${i})" title="${e.fait ? 'Cliquez pour annuler' : 'Note la visite d\'aujourd\'hui'}">${e.fait ? '✓ Fait' : 'Visité ✓'}</button>
      </div>
    </li>`;
}

// ---------- Suggestions ----------
function trPointsRepere(t) {
  const pts = trPointsEtapes(t.etapes);
  const d = trDepartPoint(t);
  if (d) pts.unshift(d);
  return pts;
}
function trDistanceMin(p, repere) {
  let m = Infinity;
  for (const r of repere) { const d = haversineKm(p, r); if (d < m) m = d; }
  return m;
}
function trSuggestions(t, gestion) {
  const repere = trPointsRepere(t);
  const rayon = PLAN_TOURNEES.rayon;
  const out = { clients: [], prospects: [], nbClients: 0 };
  if (!repere.length) return out;
  const dedans = e => (t.etapes || []).some(x => x.type === e.type && String(x.ref) === String(e.ref));
  // (a) clients qui ont du stock, par priorité
  if (gestion && gestion.parPdv) {
    for (const f of gestion.parPdv.values()) {
      if (!f || !f.pdv || f.pdv.supprime || !(f.stockTotal > 0) || !f.pdv.id) continue;
      const b = f.pdv.librairie_id ? trLib(f.pdv.librairie_id) : null;
      if (!b || !trValide({ lat: b.latitude, lon: b.longitude })) continue;
      const item = { type: 'pdv', ref: f.pdv.id, nom: f.pdv.nom, commune: f.pdv.ville || b.commune, priorite: f.priorite, stock: f.stockTotal };
      if (dedans(item)) continue;
      item.km = trDistanceMin({ lat: trNum(b.latitude), lon: trNum(b.longitude) }, repere);
      if (item.km <= rayon) out.clients.push(item);
    }
    out.clients.sort((a, b) => (a.priorite - b.priorite) || (a.km - b.km));
  }
  // (b) les 10 meilleurs prospects (à contacter, non clients, non fermés), par ressemblance
  const cand = [];
  for (const b of (state.bookstores || [])) {
    if (b.statut_prospection !== 'A_CONTACTER' || b.etablissement_ferme) continue;
    if (!trValide({ lat: b.latitude, lon: b.longitude })) continue;
    const km = trDistanceMin({ lat: trNum(b.latitude), lon: trNum(b.longitude) }, repere);
    if (km > rayon) continue;
    if (estClient(b.id) || isExclusivelyJBM(b)) continue;
    const item = { type: 'lib', ref: b.id, nom: b.nom, commune: b.commune, km };
    if (dedans(item)) continue;
    const r = ressemblance(b);
    item.score = r ? r.score : -1;
    cand.push(item);
  }
  cand.sort((a, b) => (b.score - a.score) || (a.km - b.km));
  out.prospects = cand.slice(0, 10);
  return out;
}
function trLigneSuggestion(item, fonction, i) {
  return `
    <div class="tr-sugg">
      <span class="tr-sugg-main"><strong>${trEsc(item.nom)}</strong> <span class="g-muted">${trEsc(item.commune || '')}${item.km !== undefined ? ` · à ${Math.round(item.km)} km` : ''}${item.stock ? ` · ${trEsc(trPluriel(item.stock, 'livre'))} en dépôt` : ''}${item.score >= 0 && item.type === 'lib' ? ` · ressemblance ${trEsc(item.score)}/100` : ''}</span></span>
      <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.${fonction}(${i})">+ Ajouter</button>
    </div>`;
}

// ---------- Recherche par nom ----------
function trRechercher(texte, t) {
  const q = trNorm(texte).trim();
  if (q.length < 3) return [];
  const dedans = e => ((t && t.etapes) || []).some(x => x.type === e.type && String(x.ref) === String(e.ref));
  const out = [];
  try {
    for (const p of Object.values(Suivi.collection('pdv'))) {
      if (out.length >= 8) break;
      if (!p || p.supprime || !p.id) continue;
      if (trNorm([p.nom, ...(p.noms || []), p.ville].join(' ')).includes(q)) out.push({ type: 'pdv', ref: p.id, nom: p.nom, commune: p.ville, deja: dedans({ type: 'pdv', ref: p.id }) });
    }
    for (const b of (state.bookstores || [])) {
      if (out.length >= 8) break;
      if (estClient(b.id)) continue; // déjà proposé comme client
      if (trNorm(`${b.nom} ${b.commune}`).includes(q)) out.push({ type: 'lib', ref: b.id, nom: b.nom, commune: b.commune + (b.statut_prospection === 'FERMEE' ? ' (fermée)' : ''), deja: dedans({ type: 'lib', ref: b.id }) });
    }
  } catch (e) { /* données indisponibles : aucun résultat */ }
  return out;
}
function trHtmlResultats() {
  const r = PLAN_TOURNEES.resultats;
  if (PLAN_TOURNEES.recherche.trim().length < 3) return '<p class="g-muted">Tapez au moins 3 lettres.</p>';
  if (!r.length) return '<p class="g-muted">Aucun résultat.</p>';
  return r.map((item, i) => item.deja
    ? `<div class="tr-sugg"><span class="tr-sugg-main"><strong>${trEsc(item.nom)}</strong> <span class="g-muted">${trEsc(item.commune || '')} · ${item.type === 'pdv' ? 'client' : 'prospect'}</span></span><span class="g-muted">déjà dans la tournée</span></div>`
    : `<div class="tr-sugg"><span class="tr-sugg-main"><strong>${trEsc(item.nom)}</strong> <span class="g-muted">${trEsc(item.commune || '')} · ${item.type === 'pdv' ? 'client' : 'prospect'}</span></span><button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.ajouterResultat(${i})">+ Ajouter</button></div>`).join('');
}

// ---------- Carte ----------
function trDetruireCarte() {
  if (PLAN_TOURNEES.carte) {
    try { PLAN_TOURNEES.carte.remove(); } catch (e) { /* déjà détruite */ }
    PLAN_TOURNEES.carte = null;
  }
}
function trDessinerCarte(t) {
  try {
    if (typeof L === 'undefined' || !L || !L.map) return;
    const el = document.getElementById('tr-carte');
    if (!el) return;
    const carte = L.map(el, { scrollWheelZoom: false });
    PLAN_TOURNEES.carte = carte;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(carte);
    const pin = (txt, classe) => L.divIcon({ className: 'tr-pin-wrap', html: `<div class="tr-pin ${classe}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const coords = [];
    const d = trDepartPoint(t);
    if (d) {
      coords.push([d.lat, d.lon]);
      L.marker([d.lat, d.lon], { icon: pin('🏠', 'tr-pin-depart') }).addTo(carte).bindPopup(`Départ : ${trEsc(t.depart.libelle || '')}`);
    }
    (t.etapes || []).forEach((e, i) => {
      if (!trValide(e)) return;
      const p = [trNum(e.lat), trNum(e.lon)];
      coords.push(p);
      const classe = e.fait ? 'tr-pin-fait' : (e.type === 'pdv' ? 'tr-pin-client' : 'tr-pin-prospect');
      L.marker(p, { icon: pin(i + 1, classe) }).addTo(carte).bindPopup(`${i + 1}. ${trEsc(e.nom || '')}<br>${trEsc(e.commune || '')}`);
    });
    const trace = coords.slice();
    if (t.retour_au_depart && d && coords.length > 1) trace.push([d.lat, d.lon]);
    if (trace.length > 1) L.polyline(trace, { color: '#0284c7', weight: 3, opacity: 0.8, dashArray: '6 8' }).addTo(carte);
    if (coords.length > 1) carte.fitBounds(coords, { padding: [30, 30], maxZoom: 13 });
    else if (coords.length === 1) carte.setView(coords[0], 11);
    else carte.setView([47.9, -3.8], 8);
    setTimeout(() => { try { carte.invalidateSize(); } catch (e) { /* carte détruite entre-temps */ } }, 250);
  } catch (e) {
    trDetruireCarte();
  }
}

// ---------- Affichage principal ----------
function renderTourneesView() {
  const box = document.getElementById('tournees-content');
  if (!box) return;
  trDetruireCarte();
  const y = window.scrollY;
  try {
    box.innerHTML = trHtmlVue();
  } catch (e) {
    box.innerHTML = '<p class="g-muted">Impossible d\'afficher les tournées pour le moment. Rechargez la page.</p>';
    return;
  }
  const t = trCourante();
  if (t && document.getElementById('tr-carte')) trDessinerCarte(t);
  try { window.scrollTo(0, y); } catch (e) { /* ignoré */ }
}

function trHtmlVue() {
  const t = trCourante();
  const toutes = trActives().sort(trTri);
  const entete = `
    <section class="g-card">
      <h3>🚗 Mes tournées</h3>
      <p class="g-help">Préparez une tournée en voiture : ajoutez des clients et des librairies (bouton « 🚗 Tournée » de leur fiche, ou les suggestions plus bas), puis cliquez sur « Optimiser l'ordre » pour obtenir un trajet raisonnable. Notez chaque visite avec « Visité ✓ » : le client ou la librairie est alors mis à jour.</p>
      <div class="g-toolbar">
        ${toutes.length ? `<select class="form-control" onchange="PLAN_TOURNEES_ACTIONS.choisir(this.value)" style="max-width:420px;" aria-label="Choisir une tournée">
          ${toutes.map(x => `<option value="${trEsc(x.id)}" ${t && x.id === t.id ? 'selected' : ''}>${trEsc(x.nom || 'Tournée')}${trDateOk(x.date) ? ' — ' + trEsc(trDateFr(x.date)) : ''} (${x.statut === 'faite' ? 'faite' : 'en préparation'})</option>`).join('')}
        </select>` : ''}
        <button class="btn btn-primary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.nouvelle()">+ Nouvelle tournée</button>
      </div>
    </section>`;
  if (!t) {
    return entete + '<section class="g-card g-wide"><p class="g-muted">Aucune tournée pour l\'instant. Cliquez sur « Nouvelle tournée », ou ajoutez une librairie ou un client depuis sa fiche.</p></section>';
  }

  const etapes = Array.isArray(t.etapes) ? t.etapes : [];
  const gestion = (() => { try { return calculGestion(); } catch (e) { return null; } })();
  const depart = trDepartPoint(t);
  const km = trKm(depart, etapes, t.retour_au_depart);
  const duree = trMinutes(km, etapes.length, t.duree_visite_min);
  const nbFaites = etapes.filter(e => e.fait).length;
  const liens = liensGoogleMaps(depart, trPointsEtapes(etapes), !!t.retour_au_depart);
  const carteDispo = typeof L !== 'undefined' && !!L && !!L.map;

  const reglages = `
    <section class="g-card g-wide">
      <div class="g-form-grid">
        <label class="tr-champ">Nom de la tournée <input type="text" class="form-control" value="${trEsc(t.nom || '')}" onchange="PLAN_TOURNEES_ACTIONS.renommer(this.value)"></label>
        <label class="tr-champ">Date prévue <input type="date" class="form-control" value="${trDateOk(t.date) ? trEsc(t.date) : ''}" onchange="PLAN_TOURNEES_ACTIONS.changerDate(this.value)"></label>
      </div>
      <div class="tr-depart">
        <span>🏠 Départ : <strong>${trEsc((t.depart && t.depart.libelle) || 'non défini')}</strong></span>
        <input type="text" id="tr-depart-adresse" class="form-control" placeholder="Autre adresse de départ (ex. 12 rue de Siam, Brest)" onkeydown="if(event.key==='Enter'){PLAN_TOURNEES_ACTIONS.changerDepart();}">
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.changerDepart()">Changer le départ</button>
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.departClohars()">Clohars-Carnoët</button>
      </div>
    </section>`;

  const liste = `
    <section class="g-card">
      <h3>📍 Étapes <span class="g-count">${etapes.length}</span>${nbFaites ? `<span class="g-count">${nbFaites} visitée(s)</span>` : ''}</h3>
      ${etapes.length ? `<ol class="tr-liste">${etapes.map((e, i) => trLigneEtape(t, e, i, gestion)).join('')}</ol>` : '<p class="g-muted">Aucune étape. Ajoutez des librairies depuis leur fiche, ou utilisez les suggestions et la recherche plus bas.</p>'}
      <div class="tr-options">
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.optimiser()" ${etapes.filter(e => !e.fait).length < 2 ? 'disabled' : ''} title="Réordonne les étapes pour raccourcir le trajet">✨ Optimiser l'ordre</button>
        <label class="tr-inline"><input type="checkbox" ${t.retour_au_depart ? 'checked' : ''} onchange="PLAN_TOURNEES_ACTIONS.retour(this.checked)"> Retour au départ</label>
        <label class="tr-inline">Durée d'une visite <input type="number" class="form-control tr-duree" min="0" max="240" step="5" value="${trEsc(Number(t.duree_visite_min) || 0)}" onchange="PLAN_TOURNEES_ACTIONS.duree(this.value)"> min</label>
      </div>
      ${etapes.length ? `
      <div class="tr-resume">
        <strong>Distance : environ ${Math.round(km)} km</strong> · <strong>Durée estimée : ${trEsc(trDuree(duree))}</strong>
        <div class="g-muted">Estimation (trajet à vol d'oiseau × 1,3, à 60 km/h, plus ${trEsc(trPluriel(Number(t.duree_visite_min) || 0, 'minute'))} par visite). Google Maps donne la distance exacte.</div>
      </div>
      <div class="tr-liens">
        ${liens.length === 1
          ? `<a class="btn btn-primary btn-sm" href="${trEsc(liens[0].url)}" target="_blank" rel="noopener">🗺️ Ouvrir l'itinéraire dans Google Maps</a>`
          : `<span class="g-muted" style="width:100%;">Google Maps limite le nombre d'étapes par lien : l'itinéraire est découpé en ${liens.length} parties, à ouvrir l'une après l'autre.</span>
             ${liens.map(l => `<a class="btn btn-primary btn-sm" href="${trEsc(l.url)}" target="_blank" rel="noopener">🗺️ ${trEsc(l.label)}</a>`).join('')}`}
      </div>` : ''}
      <div class="tr-options">
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.imprimer()" ${etapes.length ? '' : 'disabled'}>🖨️ Imprimer la feuille de route</button>
        ${t.statut === 'faite'
          ? '<button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.rouvrir()">↩️ Remettre en préparation</button>'
          : '<button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.terminer()">🏁 Tournée terminée</button>'}
        <button class="btn btn-secondary btn-sm" onclick="PLAN_TOURNEES_ACTIONS.supprimer()">🗑️ Supprimer cette tournée</button>
      </div>
    </section>`;

  const carte = `
    <section class="g-card tr-carte-box">
      <h3>🗺️ Carte</h3>
      ${carteDispo ? '<div id="tr-carte" class="tr-carte"></div><p class="g-muted">🏠 départ · bleu : clients · doré : prospects · gris : visités. Le tracé est à vol d\'oiseau.</p>'
        : '<p class="g-muted">La carte n\'est pas disponible pour le moment (connexion ?). La liste et les liens Google Maps fonctionnent quand même.</p>'}
    </section>`;

  const sugg = trSuggestions(t, gestion);
  PLAN_TOURNEES.suggestions = sugg.clients.concat(sugg.prospects);
  const nbC = sugg.clients.length;
  PLAN_TOURNEES.resultats = trRechercher(PLAN_TOURNEES.recherche, t);
  const suggestions = `
    <section class="g-card g-wide">
      <h3>💡 Suggestions près de la tournée</h3>
      <div class="g-toolbar">
        <label class="tr-inline">Dans un rayon de
          <select class="form-control tr-rayon" onchange="PLAN_TOURNEES_ACTIONS.rayon(this.value)">
            ${[10, 20, 30, 50].map(r => `<option value="${r}" ${r === PLAN_TOURNEES.rayon ? 'selected' : ''}>${r} km</option>`).join('')}
          </select> autour du départ et des étapes</label>
      </div>
      <div class="tr-sugg-cols">
        <div>
          <strong>Clients à voir (du stock chez eux)</strong>
          ${sugg.clients.length ? sugg.clients.slice(0, 15).map((it, i) => trLigneSuggestion(it, 'ajouterSuggestion', i)).join('') : '<p class="g-muted">Aucun client avec du stock dans ce rayon.</p>'}
          ${sugg.clients.length > 15 ? `<p class="g-muted">… et ${sugg.clients.length - 15} autre(s). Élargissez ou réduisez le rayon pour affiner.</p>` : ''}
        </div>
        <div>
          <strong>Prospects à découvrir (les plus ressemblants à vos meilleurs clients)</strong>
          ${sugg.prospects.length ? sugg.prospects.map((it, i) => trLigneSuggestion(it, 'ajouterSuggestion', nbC + i)).join('') : '<p class="g-muted">Aucun prospect à contacter dans ce rayon.</p>'}
        </div>
      </div>
      <div class="tr-recherche">
        <strong>Chercher une librairie ou un client par son nom</strong>
        <input type="search" class="form-control" placeholder="Au moins 3 lettres…" value="${trEsc(PLAN_TOURNEES.recherche)}" oninput="PLAN_TOURNEES_ACTIONS.rechercher(this.value)">
        <div id="tr-resultats">${trHtmlResultats()}</div>
      </div>
    </section>`;

  return `<div class="tr-vue">${entete}${reglages}<div class="tr-cols">${liste}${carte}</div>${suggestions}</div>`;
}

// =====================================================================================================
// Feuille de route imprimée
// =====================================================================================================

function trHtmlFeuille(t) {
  const etapes = t.etapes || [];
  const km = trKm(trDepartPoint(t), etapes, t.retour_au_depart);
  return `
    <h1>${trEsc(t.nom || 'Tournée')}</h1>
    <p>${trDateOk(t.date) ? 'Date prévue : ' + trEsc(trDateFr(t.date)) + ' · ' : ''}Départ : ${trEsc((t.depart && t.depart.libelle) || '')}${t.retour_au_depart ? ' (retour au départ)' : ''}</p>
    <p>${trEsc(trPluriel(etapes.length, 'étape'))} · environ ${Math.round(km)} km · durée estimée ${trEsc(trDuree(trMinutes(km, etapes.length, t.duree_visite_min)))}</p>
    <ol class="tr-feuille-liste">
      ${etapes.map(e => `
        <li>
          <div><strong>${trEsc(e.nom || '')}</strong> — ${e.type === 'pdv' ? 'client' : 'prospect'}${e.fait ? ' (visité)' : ''}</div>
          <div>${trEsc(trAdresse(e) || e.commune || '')}</div>
          <div>Téléphone : ${trEsc(trTelephone(e) || '—')}</div>
          <div class="tr-feuille-notes">☐ Visité · Notes : ______________________________________________</div>
        </li>`).join('')}
    </ol>`;
}

// =====================================================================================================
// Actions de l'écran (appelées par les boutons)
// =====================================================================================================

const PLAN_TOURNEES_ACTIONS = {
  choisir(id) { PLAN_TOURNEES.id = id; renderTourneesView(); },

  async nouvelle() {
    await trCreerTournee();
    renderTourneesView();
  },
  renommer(v) {
    const nom = String(v || '').trim();
    trModifier(t => { t.nom = nom || ('Tournée du ' + formatDateFr(today())); });
  },
  changerDate(v) { trModifier(t => { t.date = trDateOk(v) ? v : ''; }); },
  duree(v) {
    const n = Math.max(0, Math.min(240, Math.round(Number(v)) || 0));
    trModifier(t => { t.duree_visite_min = n; });
  },
  retour(coche) { trModifier(t => { t.retour_au_depart = !!coche; }); },

  async changerDepart() {
    const champ = document.getElementById('tr-depart-adresse');
    const texte = champ ? champ.value.trim() : '';
    if (!texte) { showToast('Tapez une adresse de départ (avec le code postal ou la ville).'); return; }
    showToast('Recherche de l\'adresse…');
    let g = null;
    try { g = await geocoderAdresse(texte, '', ''); } catch (e) { g = null; }
    if (!g) { showToast('Adresse introuvable. Essayez avec le numéro, la rue et la ville.'); return; }
    const d = { libelle: texte, lat: g.latitude, lon: g.longitude };
    trMemoriserDepart(d);
    trModifier(t => { t.depart = d; });
  },
  async departClohars() {
    PLAN_TOURNEES.departMemo = null;
    let g = null;
    try { g = await geocoderAdresse('', '29360', 'Clohars-Carnoët'); } catch (e) { g = null; }
    const d = g ? { libelle: 'Clohars-Carnoët', lat: g.latitude, lon: g.longitude } : { ...PLAN_TOURNEES.departParDefaut };
    trMemoriserDepart(d);
    trModifier(t => { t.depart = d; });
  },

  deplacer(i, sens) {
    trModifier(t => {
      const j = i + sens;
      if (!t.etapes[i] || j < 0 || j >= t.etapes.length) return false;
      [t.etapes[i], t.etapes[j]] = [t.etapes[j], t.etapes[i]];
    });
  },
  retirer(i) {
    const cur = trCourante();
    const e = cur && cur.etapes && cur.etapes[i];
    if (e && e.fait && !confirm(`« ${e.nom} » est noté comme visité. Le retirer quand même de la tournée ? (La visite déjà notée reste dans sa fiche.)`)) return;
    trModifier(t => { if (!t.etapes[i]) return false; t.etapes.splice(i, 1); });
  },
  optimiser() {
    const cur = trCourante();
    if (!cur) return;
    const depart = trDepartPoint(cur);
    if (!depart) { showToast('Choisissez d\'abord un point de départ.'); return; }
    const etapes = cur.etapes || [];
    const faites = etapes.filter(e => e.fait), reste = etapes.filter(e => !e.fait);
    if (reste.length < 2) { showToast('Il faut au moins deux étapes non visitées pour optimiser.'); return; }
    const origine = faites.length && trValide(faites[faites.length - 1]) ? { lat: trNum(faites[faites.length - 1].lat), lon: trNum(faites[faites.length - 1].lon) } : depart;
    const ordre = optimiserOrdre(origine, trPointsEtapes(reste), !!cur.retour_au_depart);
    const nouveau = faites.concat(ordre.map(k => reste[k]));
    const avant = trKm(depart, etapes, cur.retour_au_depart), apres = trKm(depart, nouveau, cur.retour_au_depart);
    if (nouveau.length !== etapes.length || apres >= avant - 0.05) { showToast(`L'ordre actuel est déjà le meilleur que je trouve (environ ${Math.round(avant)} km).`); return; }
    trModifier(t => { t.etapes = nouveau.map(e => trClone(e)); });
    showToast(`Ordre optimisé : environ ${Math.round(apres)} km au lieu de ${Math.round(avant)} km.`);
  },

  visite(i) {
    const cur = trCourante();
    const e = cur && cur.etapes && cur.etapes[i];
    if (!e) return;
    if (!e.fait) {
      let mvt = '';
      try {
        if (e.type === 'pdv') {
          mvt = 'mv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          Suivi.put('mouvements', mvt, { type: 'appel', pdv: e.ref, date: today(), commentaire: `Visite (tournée « ${cur.nom} »)`, origine: 'outil' });
        } else {
          const b = trLib(e.ref);
          if (b) {
            const patch = { date_derniere_action: today() };
            if (b.statut_prospection) patch.statut_prospection = b.statut_prospection === 'A_CONTACTER' ? 'CONTACTE' : b.statut_prospection;
            setSuivi(e.ref, patch);
          }
        }
      } catch (err) {
        showToast('La visite n\'a pas pu être notée dans la fiche. Réessayez.');
        return;
      }
      trModifier(t => { Object.assign(t.etapes[i], { fait: true, fait_le: today(), mvt }); }, true);
      if (e.type === 'pdv') { try { refreshGestion(false); } catch (err) { /* écran de gestion absent */ } }
      showToast(`Visite notée : ${e.nom}`);
    } else {
      const prospect = e.type === 'lib';
      if (!confirm(`Annuler la visite de « ${e.nom} » ?${prospect ? '\n\nLe statut de la librairie ne sera pas modifié (à corriger dans sa fiche si besoin).' : '\n\nLa visite notée dans sa fiche sera retirée.'}`)) return;
      try {
        if (e.mvt) {
          const m = Suivi.collection('mouvements')[e.mvt];
          if (m) Suivi.put('mouvements', e.mvt, { ...m, supprime: true });
        }
      } catch (err) { /* mouvement introuvable : on continue */ }
      trModifier(t => { Object.assign(t.etapes[i], { fait: false, fait_le: '', mvt: '' }); }, true);
      if (e.type === 'pdv') { try { refreshGestion(false); } catch (err) { /* ignoré */ } }
    }
    renderTourneesView();
  },

  ouvrir(i) {
    const cur = trCourante();
    const e = cur && cur.etapes && cur.etapes[i];
    if (!e) return;
    try {
      if (e.type === 'pdv') openClient(e.ref);
      else openDrawer(e.ref);
    } catch (err) { showToast('Impossible d\'ouvrir cette fiche.'); }
  },

  rayon(v) { PLAN_TOURNEES.rayon = Number(v) || 20; renderTourneesView(); },
  ajouterSuggestion(i) {
    const s = PLAN_TOURNEES.suggestions[i];
    if (s) ajouterATournee(s.type, s.ref, PLAN_TOURNEES.id);
  },
  rechercher(v) {
    PLAN_TOURNEES.recherche = String(v || '');
    PLAN_TOURNEES.resultats = trRechercher(PLAN_TOURNEES.recherche, trCourante());
    const el = document.getElementById('tr-resultats');
    if (el) el.innerHTML = trHtmlResultats();
  },
  ajouterResultat(i) {
    const s = PLAN_TOURNEES.resultats[i];
    if (s) ajouterATournee(s.type, s.ref, PLAN_TOURNEES.id);
  },

  terminer() {
    const cur = trCourante();
    if (!cur) return;
    const reste = (cur.etapes || []).filter(e => !e.fait).length;
    if (reste && !confirm(`Il reste ${trPluriel(reste, 'étape')} non visitée(s). Terminer la tournée quand même ?`)) return;
    trModifier(t => { t.statut = 'faite'; });
  },
  rouvrir() { trModifier(t => { t.statut = 'preparation'; }); },
  supprimer() {
    const cur = trCourante();
    if (!cur) return;
    if (!confirm(`Supprimer la tournée « ${cur.nom} » ?\n\nLes visites déjà notées dans les fiches restent en place.`)) return;
    const t = trClone(cur);
    t.supprime = true;
    trEnregistrer(t);
    PLAN_TOURNEES.id = null;
    renderTourneesView();
  },

  imprimer() {
    const cur = trCourante();
    if (!cur || !(cur.etapes || []).length) { showToast('Ajoutez d\'abord des étapes à la tournée.'); return; }
    try {
      let racine = document.getElementById('tr-print-root');
      if (racine) racine.remove();
      racine = document.createElement('div');
      racine.id = 'tr-print-root';
      racine.innerHTML = trHtmlFeuille(cur);
      document.body.appendChild(racine);
      document.body.classList.add('tr-impression');
      const nettoyer = () => {
        document.body.classList.remove('tr-impression');
        const r = document.getElementById('tr-print-root');
        if (r) r.remove();
        window.removeEventListener('afterprint', nettoyer);
      };
      window.addEventListener('afterprint', nettoyer);
      window.print();
    } catch (e) {
      showToast('L\'impression n\'a pas pu démarrer.');
    }
  }
};

// Export pour les tests sous Node (sans effet dans le navigateur)
if (typeof module !== 'undefined' && module.exports) module.exports = { haversineKm, optimiserOrdre, liensGoogleMaps };
