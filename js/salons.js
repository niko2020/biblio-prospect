/**
 * BIBLIO-PROSPECT — Salons et marchés
 *
 * Aide l'éditrice à choisir les salons, fêtes du livre et marchés qui valent le déplacement :
 * frais (stand, repas, kilomètres…), « point mort » (nombre de livres à vendre pour couvrir les frais),
 * date limite d'inscription et bilan de chaque événement.
 * Données : collection « salons » du suivi (Suivi.collection / Suivi.put). Aucune donnée pré-remplie.
 * Les fonctions de calcul (calculSalon, estimationVentes, kmAllerRetour) sont pures et testables sous Node.
 */

const SALONS_TYPES = ['salon du livre', 'fête du livre', 'marché de Noël', 'marché de créateurs', 'marché estival', 'autre'];
const SALONS_STATUTS = {
  idee: 'Idée', candidature: 'Candidature envoyée', accepte: 'Accepté', refuse: 'Refusé', fait: 'Fait', annule: 'Annulé'
};
// Pour la phrase d'aide à l'estimation : singulier, pluriel, féminin ?
const SALONS_NOMS_TYPES = {
  'salon du livre': ['salon du livre', 'salons du livre', false],
  'fête du livre': ['fête du livre', 'fêtes du livre', true],
  'marché de Noël': ['marché de Noël', 'marchés de Noël', false],
  'marché de créateurs': ['marché de créateurs', 'marchés de créateurs', false],
  'marché estival': ['marché estival', 'marchés estivaux', false],
  'autre': ['événement', 'événements', false]
};
const SALONS_CLE_REGLAGES = 'biblio_salons_reglages';
const SALONS_CLE_DEPART = 'biblio_depart_tournee';
const SALONS_DEFAUTS = { frais_km: 0.30, part_livre: null, depart_defaut: null };
const SALONS_ALERTE_JOURS = 21;
const SALONS_ACCUEIL_JOURS = 30;

// État de l'écran (créé sans toucher au DOM)
const SALONS_ETAT = { filtre: '', annee: null, formId: null, bilanId: null, reglagesOuverts: false, departEnCours: false };

/* ------------------------------------------------------------------ */
/* Calculs purs                                                        */
/* ------------------------------------------------------------------ */

function salonsNombre(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const salonsArrondi2 = n => Math.round(n * 100) / 100;

// Distance à vol d'oiseau en km (formule de haversine)
function distanceVolOiseau(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Aller-retour estimé : distance à vol d'oiseau × 1,3 (routes) × 2, arrondi. null si une coordonnée manque.
function kmAllerRetour(depart, lat, lon) {
  const d = depart || {};
  const v = [d.lat, d.lon, lat, lon].map(salonsNombre);
  if (v.some(x => x === null)) return null;
  return Math.round(distanceVolOiseau(v[0], v[1], v[2], v[3]) * 1.3 * 2);
}

/**
 * Chiffres d'un événement.
 * salon : { couts:{stand,hebergement,repas,autres}, km_aller_retour, ventes_prevues, ventes_reelles, recette_reelle }
 * reglages : { fraisKm, part } (alias acceptés : frais_km, partParLivre, part_livre)
 * Retourne frais, point mort, résultat prévu et verdict, résultat réel.
 */
function calculSalon(salon, reglages) {
  const s = salon || {};
  const r = reglages || {};
  const fraisKm = salonsNombre(r.fraisKm ?? r.frais_km) ?? SALONS_DEFAUTS.frais_km;
  const partBrute = salonsNombre(r.part ?? r.partParLivre ?? r.part_livre);
  const part = partBrute !== null && partBrute > 0 ? partBrute : null;
  const c = s.couts || {};
  const fraisFixes = ['stand', 'hebergement', 'repas', 'autres'].reduce((t, k) => t + (salonsNombre(c[k]) || 0), 0);
  const km = salonsNombre(s.km_aller_retour) || 0;
  const coutKm = salonsArrondi2(km * fraisKm);
  const frais = salonsArrondi2(fraisFixes + coutKm);
  // arrondi à 6 décimales avant le plafond pour éviter 10,0000000001 → 11
  const pointMort = part === null ? null : Math.max(0, Math.ceil(Math.round(frais / part * 1e6) / 1e6));

  const prevues = salonsNombre(s.ventes_prevues);
  let resultatPrevu = null;
  let verdict = null;
  if (prevues !== null && part !== null) {
    resultatPrevu = salonsArrondi2(prevues * part - frais);
    verdict = prevues >= 1.5 * pointMort ? 'rentable' : prevues >= pointMort ? 'juste' : 'perte';
  }

  const ventesReelles = salonsNombre(s.ventes_reelles);
  const recetteSaisie = salonsNombre(s.recette_reelle);
  let recetteReelle = null;
  if (recetteSaisie !== null) recetteReelle = recetteSaisie;
  else if (ventesReelles !== null && part !== null) recetteReelle = salonsArrondi2(ventesReelles * part);
  const resultatReel = recetteReelle === null ? null : salonsArrondi2(recetteReelle - frais);

  return {
    fraisFixes: salonsArrondi2(fraisFixes), coutKm, frais, part, pointMort,
    ventesPrevues: prevues, resultatPrevu, verdict,
    aBilan: ventesReelles !== null || recetteSaisie !== null,
    ventesReelles, recetteReelle, resultatReel
  };
}

/**
 * Aide à l'estimation : moyenne des ventes réelles des événements « faits » du même type.
 * Jamais de chiffre inventé : null s'il n'y a aucun historique.
 * salons : tableau ou objet d'enregistrements ; exclureId : événement en cours de saisie.
 */
function estimationVentes(salons, type, exclureId) {
  const liste = Array.isArray(salons) ? salons : Object.values(salons || {});
  const ventes = liste
    .filter(s => s && !s.supprime && s.statut === 'fait' && s.type === type && s.id !== exclureId)
    .map(s => salonsNombre(s.ventes_reelles))
    .filter(v => v !== null && v >= 0);
  if (!ventes.length) return null;
  const moyenne = Math.round(ventes.reduce((a, b) => a + b, 0) / ventes.length);
  return { n: ventes.length, moyenne, type };
}

// Moyenne des prix hors taxe numériques des titres (part « par défaut » d'un livre vendu sur place)
function salonsPartParDefaut(titres) {
  const liste = Array.isArray(titres) ? titres : Object.values(titres || {});
  const prix = liste.map(t => (t && typeof t.prix_ht === 'number' && Number.isFinite(t.prix_ht) && t.prix_ht > 0) ? t.prix_ht : null).filter(p => p !== null);
  if (!prix.length) return null;
  return salonsArrondi2(prix.reduce((a, b) => a + b, 0) / prix.length);
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const salonsJourLocal = iso => new Date(iso + 'T12:00:00');
function salonsJoursEntre(a, b) { return Math.round((salonsJourLocal(b) - salonsJourLocal(a)) / 86400000); }
function salonsAjouteJours(iso, n) {
  const d = salonsJourLocal(iso);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function salonsFinEvenement(s) { return s.date_fin || s.date_debut || ''; }

function salonsDatesTexte(s) {
  const f = d => formatDateFr(d);
  if (s.date_debut && s.date_fin && s.date_fin !== s.date_debut) return `du ${f(s.date_debut)} au ${f(s.date_fin)}`;
  if (s.date_debut) return `le ${f(s.date_debut)}`;
  if (s.date_fin) return `jusqu'au ${f(s.date_fin)}`;
  return 'dates à préciser';
}

/* ------------------------------------------------------------------ */
/* Données et réglages                                                 */
/* ------------------------------------------------------------------ */

function salonsListe() {
  let col = {};
  try { col = Suivi.collection('salons') || {}; } catch (e) { col = {}; }
  return Object.values(col).filter(s => s && typeof s === 'object' && !s.supprime && /^[\w-]+$/.test(String(s.id || '')));
}

function salonsLireReglages() {
  let r = {};
  try { r = JSON.parse(localStorage.getItem(SALONS_CLE_REGLAGES) || '{}') || {}; } catch (e) { r = {}; }
  const fraisKm = salonsNombre(r.frais_km);
  const part = salonsNombre(r.part_livre);
  return {
    frais_km: fraisKm !== null && fraisKm >= 0 ? fraisKm : SALONS_DEFAUTS.frais_km,
    part_livre: part !== null && part > 0 ? part : null,
    depart_defaut: r.depart_defaut && salonsNombre(r.depart_defaut.lat) !== null ? r.depart_defaut : null
  };
}
function salonsEcrireReglages(r) {
  try { localStorage.setItem(SALONS_CLE_REGLAGES, JSON.stringify(r)); return true; } catch (e) { return false; }
}

// Point de départ : celui du planificateur de tournées, à défaut Clohars-Carnoët (géocodé une fois)
function salonsDepart() {
  try {
    const d = JSON.parse(localStorage.getItem(SALONS_CLE_DEPART) || 'null');
    if (d && salonsNombre(d.lat) !== null && salonsNombre(d.lon) !== null) {
      return { libelle: d.libelle || 'Point de départ des tournées', lat: Number(d.lat), lon: Number(d.lon) };
    }
  } catch (e) { /* pas de départ partagé */ }
  const def = salonsLireReglages().depart_defaut;
  return def ? { libelle: def.libelle || 'Clohars-Carnoët', lat: Number(def.lat), lon: Number(def.lon) } : null;
}

async function salonsChargerDepartDefaut() {
  if (salonsDepart() || SALONS_ETAT.departEnCours) return;
  SALONS_ETAT.departEnCours = true;
  try {
    const g = await geocoderAdresse('', '29360', 'Clohars-Carnoët');
    if (g && salonsNombre(g.latitude) !== null) {
      const r = salonsLireReglages();
      r.depart_defaut = { libelle: 'Clohars-Carnoët', lat: g.latitude, lon: g.longitude };
      salonsEcrireReglages(r);
      salonsMajListe();
    }
  } catch (e) { /* sans départ, pas de distance : tout le reste fonctionne */ }
  SALONS_ETAT.departEnCours = false;
}

function salonsPartEffective(reglages) {
  const r = reglages || salonsLireReglages();
  if (r.part_livre !== null) return r.part_livre;
  try { return salonsPartParDefaut(Suivi.collection('titres')); } catch (e) { return null; }
}

// Réglages sous la forme attendue par calculSalon
function salonsReglagesCalcul() {
  const r = salonsLireReglages();
  return { fraisKm: r.frais_km, part: salonsPartEffective(r) };
}

// Kilomètres retenus : ceux saisis, sinon l'estimation depuis le départ
function salonsKm(s, depart) {
  const saisi = salonsNombre(s.km_aller_retour);
  if (saisi !== null) return saisi;
  return kmAllerRetour(depart, s.lat, s.lon);
}

function salonsCalculComplet(s, depart, reglagesCalcul) {
  const km = salonsKm(s, depart);
  return { km, calc: calculSalon({ ...s, km_aller_retour: km }, reglagesCalcul) };
}

/* ------------------------------------------------------------------ */
/* Affichage                                                           */
/* ------------------------------------------------------------------ */

const salonsNb = n => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const salonsSaisie = n => (n === null || n === undefined || n === '') ? '' : String(n).replace('.', ',');
const salonsTri = (a, b) => (a.date_debut || '9999').localeCompare(b.date_debut || '9999') || (a.nom || '').localeCompare(b.nom || '', 'fr');

function salonsEstAVenir(s, auj) {
  const fin = salonsFinEvenement(s);
  return !fin || fin >= auj;
}

function salonsUrlSure(v) {
  const t = String(v || '').trim();
  if (!t || /\s/.test(t)) return '';
  const url = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  return /^https?:\/\/[^\s]+\.[^\s]+/i.test(url) ? url : '';
}

function salonsVerdictHtml(calc) {
  if (!calc.verdict) return '';
  const textes = {
    rentable: ['sa-v-vert', '✅ Rentable'],
    juste: ['sa-v-orange', '⚠️ Juste'],
    perte: ['sa-v-rouge', '❌ À perte (sauf intérêt de visibilité)']
  };
  const [cls, txt] = textes[calc.verdict];
  const res = calc.resultatPrevu;
  return `<span class="sa-verdict ${cls}">${txt}</span> <span class="sa-muted">résultat prévu : ${res >= 0 ? '+' : ''}${euros(res)}</span>`;
}

function salonsCarteHtml(s, auj, depart, reglagesCalcul) {
  const { km, calc } = salonsCalculComplet(s, depart, reglagesCalcul);
  const id = escapeHtml(s.id);
  const statut = SALONS_STATUTS[s.statut] ? s.statut : 'idee';
  const url = salonsUrlSure(s.site_web);

  let alerte = '';
  if (statut === 'idee' && dateValide(s.date_limite_inscription)) {
    const reste = salonsJoursEntre(auj, s.date_limite_inscription);
    if (reste >= 0 && reste <= SALONS_ALERTE_JOURS) {
      alerte = `<div class="sa-alerte">⏰ Inscription avant le ${escapeHtml(formatDateFr(s.date_limite_inscription))} ${reste === 0 ? '(aujourd\'hui !)' : reste === 1 ? '(demain)' : `(dans ${reste} jours)`}</div>`;
    } else if (reste < 0 && salonsEstAVenir(s, auj)) {
      alerte = `<div class="sa-alerte sa-alerte-passee">La date limite d'inscription (${escapeHtml(formatDateFr(s.date_limite_inscription))}) est passée.</div>`;
    }
  }

  const chiffres = [];
  chiffres.push(km !== null ? `🚗 ${salonsNb(km)} km aller-retour` : '🚗 distance inconnue');
  chiffres.push(`💶 Frais : ${euros(calc.frais)}`);
  if (calc.pointMort !== null) chiffres.push(`📚 Point mort : ${salonsNb(calc.pointMort)} livre${calc.pointMort > 1 ? 's' : ''} à vendre`);
  else chiffres.push('<span class="sa-muted">Point mort : indiquez ce qui vous reste par livre dans les réglages</span>');
  if (calc.ventesPrevues !== null) chiffres.push(`Ventes prévues : ${salonsNb(calc.ventesPrevues)}`);

  let bilan = '';
  if (calc.aBilan) {
    const morceaux = [];
    if (calc.ventesReelles !== null) morceaux.push(`${salonsNb(calc.ventesReelles)} exemplaire${calc.ventesReelles > 1 ? 's' : ''} vendu${calc.ventesReelles > 1 ? 's' : ''}`);
    if (calc.recetteReelle !== null) morceaux.push(`recette ${euros(calc.recetteReelle)}`);
    if (calc.resultatReel !== null) {
      const bon = calc.resultatReel >= 0;
      morceaux.push(`<strong class="${bon ? 'sa-gain' : 'sa-perte'}">résultat ${bon ? '+' : ''}${euros(calc.resultatReel)}</strong>`);
    }
    bilan = `<div class="sa-bilan-ligne">📋 Bilan : ${morceaux.join(' · ')}</div>`;
  }

  const options = Object.keys(SALONS_STATUTS).map(k => `<option value="${k}"${k === statut ? ' selected' : ''}>${escapeHtml(SALONS_STATUTS[k])}</option>`).join('');

  return `
    <article class="sa-card sa-st-${statut}">
      <div class="sa-top">
        <div class="sa-titre">
          <strong class="sa-nom">${escapeHtml(s.nom || 'Sans nom')}</strong>
          <span class="sa-type">${escapeHtml(s.type || 'autre')}</span>
        </div>
        <select class="form-control sa-statut" onchange="salonChangerStatut('${id}', this.value)" aria-label="Statut de ${escapeHtml(s.nom || 'l\'événement')}">${options}</select>
      </div>
      <div class="sa-meta">
        <span>📍 ${escapeHtml([s.ville, s.code_postal].filter(Boolean).join(' ') || 'lieu à préciser')}</span>
        <span>📅 ${escapeHtml(salonsDatesTexte(s))}</span>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">🌐 Site web</a>` : ''}
        ${s.contact ? `<span>👤 ${escapeHtml(s.contact)}</span>` : ''}
      </div>
      ${alerte}
      <div class="sa-chiffres">${chiffres.map(c => `<span>${c}</span>`).join('')}</div>
      ${calc.verdict ? `<div class="sa-verdict-ligne">${salonsVerdictHtml(calc)}</div>` : ''}
      ${bilan}
      ${s.notes ? `<div class="sa-notes">📝 ${escapeHtml(String(s.notes).slice(0, 300))}${String(s.notes).length > 300 ? '…' : ''}</div>` : ''}
      <div class="sa-actions">
        <button class="btn btn-secondary btn-sm" onclick="salonOuvrirForm('${id}')">✏️ Modifier</button>
        <button class="btn btn-secondary btn-sm" onclick="salonOuvrirBilan('${id}')">📋 Bilan</button>
        <button class="btn btn-secondary btn-sm sa-suppr" onclick="salonSupprimer('${id}')">🗑️ Supprimer</button>
      </div>
      ${SALONS_ETAT.bilanId === s.id ? salonsBilanFormHtml(s) : ''}
    </article>`;
}

function salonsBilanFormHtml(s) {
  const id = escapeHtml(s.id);
  return `
    <div class="g-form sa-bilan-form">
      <strong>📋 Bilan de « ${escapeHtml(s.nom || '')} »</strong>
      <div class="g-form-grid">
        <label>Exemplaires vendus <input type="text" inputmode="numeric" id="sa-b-ventes" class="form-control" value="${escapeHtml(salonsSaisie(s.ventes_reelles))}" placeholder="ex. 18"></label>
        <label>Recette encaissée (€) <input type="text" inputmode="decimal" id="sa-b-recette" class="form-control" value="${escapeHtml(salonsSaisie(s.recette_reelle))}" placeholder="facultatif"></label>
      </div>
      <p class="g-help">Si vous n'indiquez pas la recette, elle est calculée avec le nombre d'exemplaires vendus.</p>
      <label>Notes (ce qui a bien marché, à refaire ou non…)
        <textarea id="sa-b-notes" class="form-control" rows="3">${escapeHtml(s.notes || '')}</textarea>
      </label>
      <div class="sa-actions">
        <button class="btn btn-primary btn-sm" onclick="salonEnregistrerBilan('${id}')">Enregistrer le bilan</button>
        <button class="btn btn-secondary btn-sm" onclick="salonFermerBilan()">Annuler</button>
      </div>
    </div>`;
}

function salonsBilanAnneeHtml(tous, depart, reglagesCalcul) {
  const auj = today();
  const faits = tous.filter(s => s.statut === 'fait');
  const anneeDe = s => parseInt((s.date_debut || s.date_fin || '').slice(0, 4), 10);
  const anneeCourante = parseInt(auj.slice(0, 4), 10);
  const annees = [...new Set([anneeCourante, ...faits.map(anneeDe).filter(Number.isFinite)])].sort((a, b) => b - a);
  if (!annees.includes(SALONS_ETAT.annee)) SALONS_ETAT.annee = anneeCourante;
  const annee = SALONS_ETAT.annee;
  const deLAnnee = faits.filter(s => anneeDe(s) === annee);

  let exemplaires = 0, recette = 0, frais = 0, avecBilan = 0;
  deLAnnee.forEach(s => {
    const { calc } = salonsCalculComplet(s, depart, reglagesCalcul);
    if (calc.resultatReel === null && calc.ventesReelles === null) return;
    avecBilan++;
    exemplaires += calc.ventesReelles || 0;
    recette += calc.recetteReelle || 0;
    frais += calc.frais;
  });
  const sansBilan = deLAnnee.length - avecBilan;
  const resultat = salonsArrondi2(recette - frais);
  const options = annees.map(a => `<option value="${a}"${a === annee ? ' selected' : ''}>${a}</option>`).join('');

  return `
    <section class="g-card g-wide sa-annee">
      <h3>📊 Bilan de l'année
        <select class="form-control sa-annee-select" onchange="salonChoisirAnnee(this.value)" aria-label="Année du bilan">${options}</select>
      </h3>
      <div class="sa-annee-grille">
        <div><span class="sa-muted">Événements faits</span><strong>${deLAnnee.length}</strong></div>
        <div><span class="sa-muted">Exemplaires vendus</span><strong>${salonsNb(exemplaires)}</strong></div>
        <div><span class="sa-muted">Recette</span><strong>${euros(recette)}</strong></div>
        <div><span class="sa-muted">Frais</span><strong>${euros(frais)}</strong></div>
        <div><span class="sa-muted">Résultat</span><strong class="${resultat >= 0 ? 'sa-gain' : 'sa-perte'}">${resultat >= 0 ? '+' : ''}${euros(resultat)}</strong></div>
      </div>
      ${sansBilan > 0 ? `<p class="g-help">${sansBilan} événement${sansBilan > 1 ? 's' : ''} sans bilan saisi, non compté${sansBilan > 1 ? 's' : ''} dans les totaux (bouton « Bilan » de la carte).</p>` : ''}
      ${deLAnnee.length === 0 ? '<p class="g-help">Aucun événement marqué « Fait » cette année-là pour l\'instant.</p>' : ''}
    </section>`;
}

function salonsListeHtml() {
  const tous = salonsListe();
  const auj = today();
  const depart = salonsDepart();
  const rc = salonsReglagesCalcul();
  const filtre = SALONS_ETAT.filtre;
  const garde = s => !filtre || (s.statut || 'idee') === filtre;

  const avenir = tous.filter(s => salonsEstAVenir(s, auj) && garde(s)).sort(salonsTri);
  const passes = tous.filter(s => !salonsEstAVenir(s, auj) && garde(s)).sort((a, b) => salonsFinEvenement(b).localeCompare(salonsFinEvenement(a)) || salonsTri(a, b));
  const cartes = l => l.map(s => salonsCarteHtml(s, auj, depart, rc)).join('');

  let vide = '';
  if (!tous.length) vide = '<p class="g-muted">Ajoutez les événements qui vous intéressent.</p>';

  return `
    ${salonsBilanAnneeHtml(tous, depart, rc)}
    <section class="g-card g-wide">
      <div class="sa-entete-liste">
        <h3>À venir <span class="g-count">${avenir.length}</span></h3>
        <label class="sa-filtre">Statut
          <select class="form-control" onchange="salonFiltrer(this.value)">
            <option value="">Tous</option>
            ${Object.keys(SALONS_STATUTS).map(k => `<option value="${k}"${filtre === k ? ' selected' : ''}>${escapeHtml(SALONS_STATUTS[k])}</option>`).join('')}
          </select>
        </label>
      </div>
      ${vide}
      ${tous.length && !avenir.length ? '<p class="g-muted">Rien à venir avec ce filtre.</p>' : ''}
      <div class="sa-liste">${cartes(avenir)}</div>
    </section>
    <section class="g-card g-wide">
      <h3>Passés <span class="g-count">${passes.length}</span></h3>
      ${passes.length ? '' : '<p class="g-muted">Aucun événement passé.</p>'}
      <div class="sa-liste">${cartes(passes)}</div>
    </section>`;
}

function salonsMajListe() {
  const zone = document.getElementById('sa-zone-liste');
  if (zone) zone.innerHTML = salonsListeHtml();
}

function salonsReglagesHtml() {
  const r = salonsLireReglages();
  const depart = salonsDepart();
  const defPart = (() => { try { return salonsPartParDefaut(Suivi.collection('titres')); } catch (e) { return null; } })();
  return `
    <details class="g-card g-wide sa-reglages" id="sa-reglages"${SALONS_ETAT.reglagesOuverts ? ' open' : ''} ontoggle="SALONS_ETAT.reglagesOuverts = this.open">
      <summary>⚙️ Réglages des calculs</summary>
      <p class="g-help">Point de départ pour les distances : <strong id="sa-depart-texte">${escapeHtml(depart ? depart.libelle : 'Clohars-Carnoët (en cours de recherche…)')}</strong>
        (le même que dans le planificateur de tournées).</p>
      <div class="g-form-grid">
        <label>Frais par kilomètre (€)
          <input type="text" inputmode="decimal" id="sa-r-km" class="form-control" value="${escapeHtml(salonsSaisie(r.frais_km))}">
        </label>
        <label>Ce qui vous reste par livre vendu sur place (€)
          <input type="text" inputmode="decimal" id="sa-r-part" class="form-control" value="${escapeHtml(salonsSaisie(r.part_livre))}" placeholder="${defPart !== null ? escapeHtml(salonsSaisie(defPart)) : 'à indiquer'}">
        </label>
      </div>
      <p class="g-help">Par défaut, le prix hors taxe moyen de vos titres${defPart !== null ? ` (${euros(defPart)})` : ''} ; la fabrication et les droits d'auteur n'en sont pas déduits : ajustez-le si vous le souhaitez. Laissez vide pour garder la valeur par défaut.</p>
      <button class="btn btn-primary btn-sm" onclick="salonEnregistrerReglages()">Enregistrer les réglages</button>
    </details>`;
}

/* ------------------------------------------------------------------ */
/* Formulaire d'un événement                                           */
/* ------------------------------------------------------------------ */

function salonsFormHtml(s) {
  const nouveau = !s;
  const e = s || { type: 'salon du livre', statut: 'idee', couts: {} };
  const c = e.couts || {};
  const champ = (id, label, valeur, extra) => `<label>${label} <input type="text" id="sa-f-${id}" class="form-control" value="${escapeHtml(valeur)}" ${extra || ''}></label>`;
  const date = (id, label, valeur) => `<label>${label} <input type="date" id="sa-f-${id}" class="form-control" value="${escapeHtml(valeur || '')}"></label>`;
  return `
    <div class="g-form sa-form">
      <strong>${nouveau ? '+ Nouvel événement' : '✏️ Modifier l\'événement'}</strong>
      <div class="g-form-grid">
        ${champ('nom', 'Nom *', e.nom || '', 'placeholder="ex. Salon du livre de…"')}
        <label>Type
          <select id="sa-f-type" class="form-control" onchange="salonMajEstimation()">
            ${SALONS_TYPES.map(t => `<option value="${escapeHtml(t)}"${t === e.type ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          </select>
        </label>
        <label>Statut
          <select id="sa-f-statut" class="form-control">
            ${Object.keys(SALONS_STATUTS).map(k => `<option value="${k}"${k === (e.statut || 'idee') ? ' selected' : ''}>${escapeHtml(SALONS_STATUTS[k])}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="g-form-grid">
        ${champ('ville', 'Ville', e.ville || '')}
        ${champ('code_postal', 'Code postal', e.code_postal || '', 'inputmode="numeric" maxlength="5"')}
      </div>
      <div class="g-form-grid">
        ${date('date_debut', 'Date de début', e.date_debut)}
        ${date('date_fin', 'Date de fin', e.date_fin)}
        ${date('date_limite_inscription', 'Inscription avant le', e.date_limite_inscription)}
      </div>
      <div class="g-form-grid">
        ${champ('site_web', 'Site web', e.site_web || '', 'placeholder="www…"')}
        ${champ('contact', 'Contact (nom, courriel, téléphone)', e.contact || '')}
      </div>
      <div class="g-form-grid">
        ${champ('stand', 'Stand (€)', salonsSaisie(c.stand), 'inputmode="decimal"')}
        ${champ('hebergement', 'Hébergement (€)', salonsSaisie(c.hebergement), 'inputmode="decimal"')}
        ${champ('repas', 'Repas (€)', salonsSaisie(c.repas), 'inputmode="decimal"')}
        ${champ('autres', 'Autres frais (€)', salonsSaisie(c.autres), 'inputmode="decimal"')}
      </div>
      <div class="g-form-grid">
        ${champ('km', 'Kilomètres aller-retour', e.km_aller_retour === null || e.km_aller_retour === undefined ? '' : String(e.km_aller_retour), 'inputmode="numeric" placeholder="calculé d\'après la ville"')}
        <label>Livres que vous pensez vendre
          <input type="text" inputmode="numeric" id="sa-f-ventes_prevues" class="form-control" value="${escapeHtml(salonsSaisie(e.ventes_prevues))}" placeholder="facultatif">
        </label>
      </div>
      <div id="sa-f-estim" class="sa-estim"></div>
      <p class="g-help">Les kilomètres sont estimés d'après la ville, à vol d'oiseau avec une marge pour les routes ; laissez vide pour les laisser calculer, ou corrigez-les.</p>
      <label>Notes
        <textarea id="sa-f-notes" class="form-control" rows="2">${escapeHtml(e.notes || '')}</textarea>
      </label>
      <div class="sa-actions">
        <button class="btn btn-primary btn-sm" id="sa-f-valider" onclick="salonEnregistrer()">Enregistrer</button>
        <button class="btn btn-secondary btn-sm" onclick="salonFermerForm()">Annuler</button>
      </div>
    </div>`;
}

function salonMajEstimation() {
  const zone = document.getElementById('sa-f-estim');
  const sel = document.getElementById('sa-f-type');
  if (!zone || !sel) return;
  const est = estimationVentes(salonsListe(), sel.value, SALONS_ETAT.formId === 'new' ? null : SALONS_ETAT.formId);
  if (!est) { zone.innerHTML = ''; return; }
  const [sing, plur, fem] = SALONS_NOMS_TYPES[est.type] || SALONS_NOMS_TYPES.autre;
  const passe = est.n > 1 ? (fem ? 'passées' : 'passés') : (fem ? 'passée' : 'passé');
  const debut = est.n > 1 ? `vos ${est.n} ${plur} ${passe}` : `votre ${sing} ${passe}`;
  zone.innerHTML = `D'après ${escapeHtml(debut)} : ${est.moyenne} exemplaire${est.moyenne > 1 ? 's' : ''} en moyenne
    <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('sa-f-ventes_prevues').value='${est.moyenne}'">Utiliser ce chiffre</button>`;
}

function salonOuvrirForm(id) {
  SALONS_ETAT.formId = id || 'new';
  const zone = document.getElementById('sa-zone-form');
  if (!zone) return;
  let s = null;
  if (id) {
    try { s = (Suivi.collection('salons') || {})[id] || null; } catch (e) { s = null; }
    if (!s) { showToast('Événement introuvable'); return; }
  }
  zone.innerHTML = salonsFormHtml(s);
  salonMajEstimation();
  zone.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const nom = document.getElementById('sa-f-nom');
  if (nom && !id) nom.focus();
}

function salonFermerForm() {
  SALONS_ETAT.formId = null;
  const zone = document.getElementById('sa-zone-form');
  if (zone) zone.innerHTML = '';
}

async function salonEnregistrer() {
  const v = id => { const el = document.getElementById('sa-f-' + id); return el ? el.value.trim() : ''; };
  const nom = v('nom');
  if (!nom) { showToast('Indiquez le nom de l\'événement'); return; }

  // Dates
  const dates = {};
  for (const [k, lib] of [['date_debut', 'début'], ['date_fin', 'fin'], ['date_limite_inscription', 'limite d\'inscription']]) {
    const brut = v(k);
    dates[k] = brut ? dateValide(brut) : '';
    if (brut && !dates[k]) { showToast(`La date de ${lib} n'est pas valide`); return; }
  }
  if (dates.date_debut && dates.date_fin && dates.date_fin < dates.date_debut) { showToast('La date de fin est avant la date de début'); return; }

  // Montants (virgule acceptée)
  const couts = {};
  for (const [k, lib] of [['stand', 'stand'], ['hebergement', 'hébergement'], ['repas', 'repas'], ['autres', 'autres frais']]) {
    const brut = v(k);
    const m = brut ? montantValide(brut) : 0;
    if (m === null) { showToast(`Le montant « ${lib} » n'est pas lisible (exemple : 45,50)`); return; }
    couts[k] = m;
  }
  const entierOuNull = (k, lib) => {
    const brut = v(k).replace(/\s/g, '');
    if (!brut) return { ok: true, val: null };
    if (!/^\d+$/.test(brut)) { showToast(`« ${lib} » doit être un nombre entier`); return { ok: false }; }
    return { ok: true, val: parseInt(brut, 10) };
  };
  const kmSaisi = entierOuNull('km', 'Kilomètres');
  if (!kmSaisi.ok) return;
  const prevues = entierOuNull('ventes_prevues', 'Livres que vous pensez vendre');
  if (!prevues.ok) return;

  const col = (() => { try { return Suivi.collection('salons') || {}; } catch (e) { return {}; } })();
  const editId = SALONS_ETAT.formId && SALONS_ETAT.formId !== 'new' ? SALONS_ETAT.formId : null;
  const ancien = editId ? (col[editId] || {}) : {};
  const bouton = document.getElementById('sa-f-valider');
  if (bouton) bouton.disabled = true;

  const ville = v('ville');
  const cp = v('code_postal');
  let lat = salonsNombre(ancien.lat);
  let lon = salonsNombre(ancien.lon);
  let avertissement = '';
  const lieuChange = !editId || ville !== (ancien.ville || '') || cp !== (ancien.code_postal || '') || lat === null || lon === null;
  if (lieuChange) {
    lat = null; lon = null;
    if (ville || cp) {
      try {
        const g = await geocoderAdresse('', cp, ville);
        if (g && salonsNombre(g.latitude) !== null) { lat = g.latitude; lon = g.longitude; }
      } catch (e) { /* on enregistre quand même */ }
      if (lat === null) avertissement = ' (distance non calculée : lieu introuvable)';
    }
  }

  // Kilomètres : saisis > recalcul automatique si vide ou si l'ancienne valeur était automatique
  let km = kmSaisi.val;
  let kmAuto = false;
  const ancienAuto = ancien.km_auto === true && salonsNombre(ancien.km_aller_retour) === km;
  if (km === null || ancienAuto) {
    const calcule = lat !== null ? kmAllerRetour(salonsDepart(), lat, lon) : null;
    if (calcule !== null) { km = calcule; kmAuto = true; }
  }

  const id = editId || 'sa-' + Date.now().toString(36);
  const enregistrement = {
    ...ancien,
    nom, type: SALONS_TYPES.includes(v('type')) ? v('type') : 'autre',
    ville, code_postal: cp, lat, lon,
    date_debut: dates.date_debut, date_fin: dates.date_fin, date_limite_inscription: dates.date_limite_inscription,
    site_web: v('site_web'), contact: v('contact'),
    statut: SALONS_STATUTS[v('statut')] ? v('statut') : 'idee',
    couts, km_aller_retour: km, km_auto: kmAuto,
    ventes_prevues: prevues.val,
    ventes_reelles: salonsNombre(ancien.ventes_reelles), recette_reelle: salonsNombre(ancien.recette_reelle),
    notes: (document.getElementById('sa-f-notes') || { value: '' }).value.trim(),
    cree_le: ancien.cree_le || new Date().toISOString()
  };
  const ok = Suivi.put('salons', id, enregistrement);
  if (bouton) bouton.disabled = false;
  if (ok === false) { showToast('Enregistrement impossible (espace de stockage plein ?)'); return; }
  showToast('Événement enregistré' + avertissement);
  salonFermerForm();
  salonsMajListe();
}

/* ------------------------------------------------------------------ */
/* Actions de la liste                                                 */
/* ------------------------------------------------------------------ */

function salonsEnregistrementPar(id) {
  try { return (Suivi.collection('salons') || {})[id] || null; } catch (e) { return null; }
}

function salonChangerStatut(id, statut) {
  const s = salonsEnregistrementPar(id);
  if (!s || !SALONS_STATUTS[statut]) return;
  Suivi.put('salons', id, { ...s, statut });
  showToast('Statut enregistré : ' + SALONS_STATUTS[statut]);
  salonsMajListe();
}

function salonFiltrer(valeur) {
  SALONS_ETAT.filtre = SALONS_STATUTS[valeur] ? valeur : '';
  salonsMajListe();
}

function salonChoisirAnnee(valeur) {
  SALONS_ETAT.annee = parseInt(valeur, 10) || null;
  salonsMajListe();
}

function salonOuvrirBilan(id) {
  SALONS_ETAT.bilanId = id;
  salonsMajListe();
}
function salonFermerBilan() {
  SALONS_ETAT.bilanId = null;
  salonsMajListe();
}

function salonEnregistrerBilan(id) {
  const s = salonsEnregistrementPar(id);
  if (!s) return;
  const lire = k => { const el = document.getElementById(k); return el ? el.value.trim() : ''; };
  const brutVentes = lire('sa-b-ventes').replace(/\s/g, '');
  if (brutVentes && !/^\d+$/.test(brutVentes)) { showToast('Le nombre d\'exemplaires vendus doit être un nombre entier'); return; }
  const brutRecette = lire('sa-b-recette');
  const recette = brutRecette ? montantValide(brutRecette) : null;
  if (brutRecette && recette === null) { showToast('La recette n\'est pas lisible (exemple : 240,50)'); return; }
  const passeAFait = s.statut === 'accepte';
  Suivi.put('salons', id, {
    ...s,
    ventes_reelles: brutVentes ? parseInt(brutVentes, 10) : null,
    recette_reelle: recette,
    notes: lire('sa-b-notes'),
    statut: passeAFait ? 'fait' : s.statut
  });
  SALONS_ETAT.bilanId = null;
  showToast(passeAFait ? 'Bilan enregistré ; l\'événement est marqué « Fait »' : 'Bilan enregistré');
  salonsMajListe();
}

function salonSupprimer(id) {
  const s = salonsEnregistrementPar(id);
  if (!s) return;
  if (!window.confirm(`Supprimer « ${s.nom || 'cet événement'} » ?`)) return;
  Suivi.put('salons', id, { ...s, supprime: true });
  if (SALONS_ETAT.bilanId === id) SALONS_ETAT.bilanId = null;
  showToast('Événement supprimé');
  salonsMajListe();
}

function salonEnregistrerReglages() {
  const brutKm = (document.getElementById('sa-r-km') || { value: '' }).value.trim();
  const brutPart = (document.getElementById('sa-r-part') || { value: '' }).value.trim();
  const km = brutKm ? montantValide(brutKm) : SALONS_DEFAUTS.frais_km;
  if (km === null) { showToast('Les frais par kilomètre ne sont pas lisibles (exemple : 0,30)'); return; }
  const part = brutPart ? montantValide(brutPart) : null;
  if (brutPart && (part === null || part <= 0)) { showToast('Ce qui vous reste par livre n\'est pas lisible (exemple : 7,50)'); return; }
  const r = salonsLireReglages();
  r.frais_km = km;
  r.part_livre = part;
  if (!salonsEcrireReglages(r)) { showToast('Réglages non enregistrés (stockage du navigateur indisponible)'); return; }
  showToast('Réglages enregistrés');
  salonsMajListe();
}

/* ------------------------------------------------------------------ */
/* Vue principale                                                      */
/* ------------------------------------------------------------------ */

function renderSalonsView() {
  const box = document.getElementById('salons-content');
  if (!box) return;
  box.innerHTML = `
    <div class="sa-vue">
      <section class="g-card g-wide">
        <h3>🎪 Salons et marchés</h3>
        <p class="g-help">Pour chaque salon ou marché, l'outil estime ce que le déplacement coûte et combien de livres il faut vendre pour s'y retrouver (le « point mort »). Il vous prévient aussi quand une inscription approche, et garde le bilan de chaque événement. Ajoutez les événements qui vous intéressent.</p>
        <button class="btn btn-primary" onclick="salonOuvrirForm()">+ Nouvel événement</button>
        <div id="sa-zone-form"></div>
      </section>
      ${salonsReglagesHtml()}
      <div id="sa-zone-liste">${salonsListeHtml()}</div>
    </div>`;
  if (SALONS_ETAT.formId) salonOuvrirFormSansDefiler();
  salonsChargerDepartDefaut();
}

// Réaffiche le formulaire resté ouvert quand on revient sur l'onglet
function salonOuvrirFormSansDefiler() {
  const id = SALONS_ETAT.formId === 'new' ? null : SALONS_ETAT.formId;
  const zone = document.getElementById('sa-zone-form');
  if (!zone) return;
  const s = id ? salonsEnregistrementPar(id) : null;
  if (id && !s) { SALONS_ETAT.formId = null; return; }
  zone.innerHTML = salonsFormHtml(s);
  salonMajEstimation();
}

/* ------------------------------------------------------------------ */
/* Bloc de l'Accueil                                                   */
/* ------------------------------------------------------------------ */

function salonsAccueilHtml() {
  try {
    const tous = salonsListe();
    if (!tous.length) return '';
    const auj = today();
    const limiteInscr = salonsAjouteJours(auj, SALONS_ALERTE_JOURS);
    const limiteProchains = salonsAjouteJours(auj, SALONS_ACCUEIL_JOURS);

    const inscriptions = tous
      .filter(s => s.statut === 'idee' && dateValide(s.date_limite_inscription)
        && s.date_limite_inscription >= auj && s.date_limite_inscription <= limiteInscr)
      .sort((a, b) => a.date_limite_inscription.localeCompare(b.date_limite_inscription));
    const prochains = tous
      .filter(s => (s.statut === 'candidature' || s.statut === 'accepte') && dateValide(s.date_debut)
        && salonsFinEvenement(s) >= auj && s.date_debut <= limiteProchains)
      .sort(salonsTri);
    if (!inscriptions.length && !prochains.length) return '';

    const ligne = (s, texte) => `
      <div class="sa-acc-ligne" onclick="goView('salons')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')goView('salons')">
        <strong>${escapeHtml(s.nom || 'Sans nom')}</strong>
        <span class="g-muted">${escapeHtml(s.ville || '')}${s.ville ? ' · ' : ''}${texte}</span>
      </div>`;
    const blocInscr = inscriptions.length ? `
      <h4 class="sa-acc-titre">⏰ Inscriptions à faire</h4>
      ${inscriptions.map(s => {
        const reste = salonsJoursEntre(auj, s.date_limite_inscription);
        return ligne(s, `inscription avant le ${escapeHtml(formatDateFr(s.date_limite_inscription))} (${reste === 0 ? 'aujourd\'hui' : reste === 1 ? 'demain' : 'dans ' + reste + ' jours'})`);
      }).join('')}` : '';
    const blocProchains = prochains.length ? `
      <h4 class="sa-acc-titre">📅 Ces 30 prochains jours</h4>
      ${prochains.map(s => ligne(s, `${escapeHtml(salonsDatesTexte(s))} · ${escapeHtml(SALONS_STATUTS[s.statut] || '')}`)).join('')}` : '';

    return `
      <section class="g-card g-wide sa-acc">
        <h3>🎪 Salons et marchés</h3>
        ${blocInscr}
        ${blocProchains}
      </section>`;
  } catch (e) {
    return '';
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { calculSalon, estimationVentes, kmAllerRetour };
