/**
 * BIBLIO-PROSPECT — Fiches créées à la main et envoi groupé
 *
 * 1. FICHES CRÉÉES À LA MAIN : un point de vente absent des listes officielles (concept store, librairie
 *    toute récente…) peut être ajouté. La fiche est enregistrée dans la sauvegarde, comme le reste du suivi,
 *    sous un identifiant à part (au-delà de 800 000 000 000 000) : aucune mise à jour des données ne peut
 *    la remplacer. La position sur la carte vient de la Base Adresse Nationale (api-adresse.data.gouv.fr).
 * 2. COPIER LES EMAILS des librairies affichées, pour un envoi en copie cachée (Cci).
 */
const ID_FICHE_MANUELLE_MIN = 800000000000000;
const TYPES_FICHE_MANUELLE = ['Librairie', 'Concept store', 'Maison de la presse', 'Boutique de créateurs', 'Café-librairie', 'Autre point de vente'];

const estFicheManuelle = id => Number(id) >= ID_FICHE_MANUELLE_MIN;

// Fiche affichable (mêmes champs que les fiches des listes officielles) à partir de ce qui a été saisi
function ficheManuelleVersItem(id, fm) {
  const dep = String(fm.code_postal || '').startsWith('97') ? String(fm.code_postal).slice(0, 3) : String(fm.code_postal || '').slice(0, 2);
  const geo = (window.FRANCE_GEO && FRANCE_GEO.departements || []).find(d => d.code === (fm.departement_code || dep)) || null;
  const region = geo && (FRANCE_GEO.regions || []).find(r => r.code === geo.region);
  const saisie = { source: 'Fiche créée par vous', niveau: 'saisie', date: fm.cree_le || '' };
  const info = { adresse: saisie };
  if (fm.telephone) info.telephone = saisie;
  if (fm.email) info.email = saisie;
  if (fm.site_web) info.site_web = saisie;
  if (Number.isFinite(fm.latitude)) info.position = { source: 'Base Adresse Nationale, d\'après l\'adresse saisie', niveau: 'probable', date: fm.cree_le || '' };
  const type = fm.type || 'Autre point de vente';
  return {
    id, alias_ids: [], nom: fm.nom, autres_noms: [], categories: [type], lignes_officielles: 0, label_qualite: '',
    commune: fm.commune || '', code_commune: fm.code_commune || '', code_postal: fm.code_postal || '', population: null,
    departement_code: geo ? geo.code : dep, departement_nom: geo ? geo.nom : '', region_code: geo ? geo.region : '', region: region ? region.nom : '',
    adresse: [fm.adresse, fm.code_postal, fm.commune].filter(Boolean).join(' ').toUpperCase(),
    localisation: Number.isFinite(fm.latitude) ? 'adresse' : '', latitude: Number.isFinite(fm.latitude) ? fm.latitude : null, longitude: Number.isFinite(fm.longitude) ? fm.longitude : null,
    siret: '', siren: '', nom_officiel: '', naf: '', sirene_statut: 'non_trouve', sirene_motif: '', sirene_piste: null,
    telephone: fm.telephone || '', email: fm.email || '', site_web: fm.site_web || '', horaires: '', osm_url: '',
    google_rating: null, google_reviews_count: null, info, assortiment: type, is_lir: false,
    google_maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${fm.nom} ${fm.commune || ''} ${fm.code_postal || ''}`)}`,
    fiche_manuelle: true,
    statut_prospection: 'A_CONTACTER', priorite: 'MOYENNE', is_favorite: false, contact_referent: '',
    notes_prospection: '', date_derniere_action: '', date_relance: ''
  };
}

// Ajoute / met à jour / retire les fiches créées à la main (appelé avant chaque application du suivi)
function synchroniserFichesManuelles(entries) {
  for (const [k, e] of Object.entries(entries || {})) {
    if (!e || !e.fiche_manuelle || !estFicheManuelle(k)) continue;
    const id = Number(k);
    if (e.fiche_manuelle.supprimee) state.baseById.delete(id);
    else state.baseById.set(id, ficheManuelleVersItem(id, e.fiche_manuelle));
  }
}

// Position et commune officielle d'une adresse (Base Adresse Nationale) ; null si introuvable ou hors ligne
async function geocoderAdresse(adresse, codePostal, commune) {
  try {
    const q = encodeURIComponent([adresse, codePostal, commune].filter(Boolean).join(' '));
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${q}&limit=1${/^\d{5}$/.test(codePostal) ? '&postcode=' + codePostal : ''}`, { signal: ctrl.signal });
    clearTimeout(minuteur);
    if (!res.ok) return null;
    const f = (await res.json()).features?.[0];
    if (!f || f.properties.score < 0.4) return null;
    return { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0], code_commune: f.properties.citycode, commune_officielle: f.properties.city };
  } catch (e) {
    return null;
  }
}

function fenetre(id, html) {
  let modal = document.getElementById(id);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = id;
    modal.className = 'modal-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = html;
  modal.classList.add('active');
  return modal;
}

// Formulaire de création (ou de modification, avec l'identifiant d'une fiche créée à la main)
function ouvrirNouvelleFiche(id) {
  const fm = id ? (Suivi.all()[id] || {}).fiche_manuelle || {} : {};
  const champ = (k, label, attrs = '') => `<div class="form-group"><label>${label}</label><input class="form-control" id="nf-${k}" value="${escapeHtml(fm[k] || '')}" ${attrs}></div>`;
  fenetre('fiche-modal', `
    <div class="modal-card" style="max-width:560px;">
      <div class="modal-header">
        <h3 style="font-family:var(--font-heading);font-weight:700;">${id ? '✏️ Modifier la fiche' : '➕ Nouvelle fiche'}</h3>
        <button class="drawer-close-btn" onclick="document.getElementById('fiche-modal').classList.remove('active')">✕</button>
      </div>
      <div class="modal-body">
        <p class="g-muted" style="font-size:0.78rem;">Pour un point de vente absent des listes officielles (concept store, librairie toute récente…). La fiche est enregistrée avec votre suivi ; les mises à jour mensuelles des données ne la modifient jamais.</p>
        ${champ('nom', 'Nom *', 'placeholder="ex. La Petite Manne"')}
        <div class="form-group"><label>Type</label><select class="form-control" id="nf-type">${TYPES_FICHE_MANUELLE.map(t => `<option ${(fm.type || 'Librairie') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        ${champ('adresse', 'Adresse', 'placeholder="ex. 3 rue du Port"')}
        <div style="display:grid;grid-template-columns:8rem 1fr;gap:0.5rem;">
          ${champ('code_postal', 'Code postal *', 'inputmode="numeric" maxlength="5"')}
          ${champ('commune', 'Commune *')}
        </div>
        ${champ('telephone', 'Téléphone')}
        ${champ('email', 'Email', 'type="email"')}
        ${champ('site_web', 'Site web')}
        <p id="nf-erreur" class="data-check" style="display:none;"></p>
        <div style="display:flex;justify-content:space-between;gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap;">
          ${id ? `<button class="btn btn-secondary g-danger" onclick="supprimerFicheManuelle(${id})">🗑️ Supprimer la fiche</button>` : '<span></span>'}
          <span style="display:flex;gap:0.5rem;">
            <button class="btn btn-secondary" onclick="document.getElementById('fiche-modal').classList.remove('active')">Annuler</button>
            <button class="btn btn-primary" id="nf-ok" onclick="enregistrerNouvelleFiche(${id || 0})">Enregistrer</button>
          </span>
        </div>
      </div>
    </div>`);
  setTimeout(() => document.getElementById('nf-nom')?.focus(), 50);
}

async function enregistrerNouvelleFiche(idExistant) {
  const v = k => (document.getElementById('nf-' + k)?.value || '').trim();
  const err = document.getElementById('nf-erreur');
  const erreur = t => { err.textContent = t; err.style.display = ''; };
  const fm = { nom: v('nom'), type: v('type'), adresse: v('adresse'), code_postal: v('code_postal'), commune: v('commune'), telephone: v('telephone'), email: v('email'), site_web: v('site_web') };
  if (!fm.nom) return erreur('Indiquez le nom.');
  if (!/^\d{5}$/.test(fm.code_postal)) return erreur('Code postal : 5 chiffres.');
  if (!fm.commune) return erreur('Indiquez la commune.');
  if (fm.telephone && !safeTel(fm.telephone)) return erreur('Téléphone incomplet ou invalide.');
  if (fm.email && !safeEmail(fm.email)) return erreur('Email invalide.');
  if (fm.site_web && !safeUrl(fm.site_web)) return erreur('Adresse du site invalide (elle doit commencer par http:// ou https://).');
  // Déjà présente dans les listes ? (même nom dans la même commune)
  if (!idExistant) {
    const n = normTxt(fm.nom), c = normTxt(fm.commune);
    const doublon = state.bookstores.find(b => normTxt(b.commune) === c && (normTxt(b.nom) === n || normTxt(b.nom).includes(n) || n.includes(normTxt(b.nom))));
    if (doublon && !confirm(`« ${doublon.nom} » (${doublon.commune}) existe déjà dans les listes. Créer quand même une nouvelle fiche ?`)) return;
  }
  const bouton = document.getElementById('nf-ok');
  if (bouton) { bouton.disabled = true; bouton.textContent = 'Localisation…'; }
  const precedent = idExistant ? (Suivi.all()[idExistant] || {}).fiche_manuelle || {} : {};
  const memeAdresse = idExistant && precedent.adresse === fm.adresse && precedent.code_postal === fm.code_postal && precedent.commune === fm.commune;
  const pos = memeAdresse ? null : await geocoderAdresse(fm.adresse, fm.code_postal, fm.commune);
  const fiche = {
    ...precedent, ...fm,
    cree_le: precedent.cree_le || new Date().toISOString().slice(0, 10),
    ...(pos ? { latitude: pos.latitude, longitude: pos.longitude, code_commune: pos.code_commune } : memeAdresse ? {} : { latitude: null, longitude: null })
  };
  const id = idExistant || ID_FICHE_MANUELLE_MIN + Date.now();
  Suivi.update(id, { fiche_manuelle: fiche });
  applySuiviToAll();
  applyFilters();
  updateKpis();
  document.getElementById('fiche-modal')?.classList.remove('active');
  showToast(idExistant ? 'Fiche modifiée.' : `Fiche « ${fm.nom} » créée${pos ? '' : ' (position sur la carte non trouvée : vérifiez l\'adresse)'}.`);
  openDrawer(id);
}

function supprimerFicheManuelle(id) {
  const e = Suivi.all()[id];
  if (!e || !e.fiche_manuelle) return;
  if (!confirm(`Supprimer la fiche « ${e.fiche_manuelle.nom} » ? Elle disparaît des listes (elle reste récupérable dans l'historique de la sauvegarde). Si c'est une librairie fermée, préférez le statut « Fermée ».`)) return;
  Suivi.update(id, { fiche_manuelle: { ...e.fiche_manuelle, supprimee: true, supprimee_le: new Date().toISOString().slice(0, 10) } });
  document.getElementById('fiche-modal')?.classList.remove('active');
  if (typeof closeDrawer === 'function') closeDrawer();
  applySuiviToAll();
  applyFilters();
  updateKpis();
  showToast('Fiche supprimée.');
}

/**
 * Emails des librairies affichées (après les filtres), à coller dans le champ « Cci » de la messagerie
 */
function copierEmails() {
  const liste = state.filteredBookstores || [];
  const emails = [...new Set(liste.map(b => safeEmail(b.email)).filter(Boolean))];
  if (!emails.length) { showToast('Aucun email connu parmi les librairies affichées.'); return; }
  const texte = emails.join(', ');
  const message = `${emails.length} email(s) pour ${liste.length} librairie(s) affichée(s)${liste.length > emails.length ? ` (${liste.length - emails.length} sans email connu)` : ''}. Collez-les dans le champ « Cci » (copie cachée) de votre messagerie, pour que les libraires ne voient pas les adresses des autres.`;
  const repli = () => fenetreTexte('📋 Emails des librairies affichées', message + ' Sélectionnez puis copiez (Cmd+C sur Mac).', texte);
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(texte).then(() => fenetreTexte('📋 Emails copiés', message, texte), repli);
  else repli();
}

function fenetreTexte(titre, message, texte) {
  const modal = fenetre('texte-modal', `
    <div class="modal-card" style="max-width:640px;">
      <div class="modal-header">
        <h3 style="font-family:var(--font-heading);font-weight:700;">${escapeHtml(titre)}</h3>
        <button class="drawer-close-btn" onclick="document.getElementById('texte-modal').classList.remove('active')">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.85rem;">${escapeHtml(message)}</p>
        <textarea class="form-control" readonly rows="8" style="width:100%;font-size:0.78rem;" onclick="this.select()">${escapeHtml(texte)}</textarea>
      </div>
    </div>`);
  modal.querySelector('textarea').select();
}
