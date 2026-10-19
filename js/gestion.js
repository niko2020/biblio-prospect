/**
 * BIBLIO-PROSPECT — Gestion du dépôt-vente
 *
 * Les données de gestion sont une liste de MOUVEMENTS datés (dépôt, vente déclarée, retour, appel, note)
 * et de FACTURES, enregistrés dans la sauvegarde (js/suivi.js). Tout le reste se CALCULE à partir d'eux :
 * stock chez chaque point de vente, ventes à facturer, impayés, points de vente à appeler.
 * Rien n'est donc saisi deux fois, et rien ne « casse » au changement d'année.
 *
 * Règles (modifiables ici) :
 */
const GESTION_REGLES = {
  joursSansContact: 30,     // « à appeler » : du stock et pas de contact depuis ce délai (tour mensuel des dépôts)
  partStockBas: 0.2,        // « réassort » : le client a vendu et il lui reste au plus 20 % de ce qui a été déposé
  joursApresFinDeMois: 30,  // échéance des factures : « 30 jours fin de mois » (mention de ses factures)
  commissionParDefaut: 0.3  // quand le carnet d'adresses n'indique pas la commission
};

const MVT_TYPES = {
  depot: { label: 'Dépôt', icon: '📦', signe: 1 },
  vente: { label: 'Ventes déclarées', icon: '💰', signe: -1 },
  retour: { label: 'Retour', icon: '↩️', signe: -1 },
  appel: { label: 'Appel', icon: '📞', signe: 0 },
  note: { label: 'Note', icon: '📝', signe: 0 }
};

const euros = n => (n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const today = () => new Date().toISOString().slice(0, 10);
const joursDepuis = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : Infinity;
const actifs = obj => Object.values(obj || {}).filter(r => !r.supprime);

// Échéance « 30 jours fin de mois » : dernier jour du mois de la facture + 30 jours (15/01 → 02/03)
function echeanceFacture(dateIso) {
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}/.test(dateIso)) return null;
  const [y, m] = dateIso.split('-').map(Number);
  const finDeMois = new Date(Date.UTC(y, m, 0)); // jour 0 du mois suivant = dernier jour du mois
  finDeMois.setUTCDate(finDeMois.getUTCDate() + GESTION_REGLES.joursApresFinDeMois);
  return finDeMois.toISOString().slice(0, 10);
}

/**
 * Calcul de toute la situation à partir des mouvements et des factures
 */
function calculGestion() {
  const pdvs = Suivi.collection('pdv');
  const titres = Suivi.collection('titres');
  const mouvements = actifs(Suivi.collection('mouvements'));
  const factures = actifs(Suivi.collection('factures'));
  const anomalies = actifs(Suivi.collection('anomalies'));

  const parPdv = new Map();
  const aujourdhui = today();
  const fiche = pid => {
    if (!parPdv.has(pid)) {
      parPdv.set(pid, {
        pdv: pdvs[pid] || { id: pid, nom: '(point de vente inconnu)' }, stock: {}, stockTotal: 0, valeurStock: 0,
        dernierContact: null, ventesNonFacturees: [], aFacturer: 0, facturesImpayees: [], impayes: 0,
        totalVentes: 0, chiffreAffaires: 0, mouvements: [], factures: [], deposes: {}, vendus: {}, raisons: [], datesFutures: []
      });
    }
    return parPdv.get(pid);
  };

  for (const m of mouvements) {
    if (!m.pdv) continue;
    const f = fiche(m.pdv);
    f.mouvements.push(m);
    const t = MVT_TYPES[m.type];
    if (t && t.signe && m.isbn) f.stock[m.isbn] = (f.stock[m.isbn] || 0) + t.signe * (m.qte || 0);
    if (m.isbn && m.type === 'depot') f.deposes[m.isbn] = (f.deposes[m.isbn] || 0) + (m.qte || 0);
    if (m.isbn && m.type === 'vente') f.vendus[m.isbn] = (f.vendus[m.isbn] || 0) + (m.qte || 0);
    // Une date dans le futur est une faute de frappe probable : elle ne compte pas comme dernier contact
    if (m.date && !m.date_approx && m.date > aujourdhui) f.datesFutures.push(m);
    else if (m.date && (!f.dernierContact || m.date > f.dernierContact) && !m.date_approx) f.dernierContact = m.date;
    if (m.type === 'vente') {
      f.totalVentes += m.qte || 0;
      if (!m.facture) f.ventesNonFacturees.push(m);
    }
  }
  for (const fa of factures) {
    if (!fa.pdv) continue;
    const f = fiche(fa.pdv);
    f.factures.push(fa);
    f.chiffreAffaires += fa.montant_net_ht || 0;
    if (!fa.payee) { f.facturesImpayees.push(fa); f.impayes += fa.montant_net_ht || 0; }
    if (fa.date && (!f.dernierContact || fa.date > f.dernierContact)) f.dernierContact = fa.date;
  }

  const aAppeler = [], aFacturer = [], impayes = [];
  let stockEx = 0, stockValeur = 0, totalAFacturer = 0, totalImpayes = 0;
  for (const f of parPdv.values()) {
    const commission = f.pdv.commission ?? GESTION_REGLES.commissionParDefaut;
    for (const [isbn, q] of Object.entries(f.stock)) {
      if (q > 0) {
        f.stockTotal += q;
        f.valeurStock += q * (titres[isbn]?.prix_ht || 0);
      }
    }
    f.aFacturer = f.ventesNonFacturees.reduce((s, m) => s + (m.qte || 0) * (m.prix_ht || titres[m.isbn]?.prix_ht || 0) * (1 - commission), 0);
    f.commission = commission;
    stockEx += f.stockTotal;
    stockValeur += f.valeurStock;
    totalAFacturer += f.aFacturer;
    totalImpayes += f.impayes;
    // Raisons d'appeler, de la plus urgente à la moins urgente
    const sansContact = joursDepuis(f.dernierContact);
    const lib = f.pdv.librairie_id && typeof state !== 'undefined' && state.baseById ? state.baseById.get(f.pdv.librairie_id) : null;
    const titre = isbn => titres[isbn]?.titre || isbn;
    if (lib && lib.etablissement_ferme && f.stockTotal > 0) {
      f.raisons.push({ type: 'ferme', texte: `🚪 Établissement fermé${lib.etablissement_ferme.date_fermeture ? ' le ' + formatDateFr(lib.etablissement_ferme.date_fermeture) : ''} (base officielle) : récupérer le stock` });
    }
    // Procédure collective publiée au BODACC : stock à récupérer, créance à déclarer (délais légaux)
    const p = lib && lib.procedure;
    if (p && typeof PROCEDURES !== 'undefined' && (PROCEDURES[p.type] || {}).grave && (f.stockTotal > 0 || f.facturesImpayees.length)) {
      const d = PROCEDURES[p.type];
      // Les délais courent depuis la publication du jugement d'ouverture
      const pub = (p.ouverture && p.ouverture.date_parution) || p.date_parution;
      const delai = mois => { const lim = plusMois(pub, mois); return `avant le ${formatDateFr(lim)}${lim < aujourdhui ? ', délai dépassé' : ''}`; };
      const factures = f.facturesImpayees.map(fa => `${fa.numero}${fa.montant_net_ht != null ? ' ' + euros(fa.montant_net_ht) : ''}`).join(', ');
      const actions = [];
      if (p.type === 'cloture') {
        actions.push("l'entreprise a probablement cessé son activité");
        if (f.stockTotal > 0) actions.push(`récupérer les ${f.stockTotal} ex. en dépôt`);
      } else {
        if (f.facturesImpayees.length) actions.push(`déclarer la créance impayée (${factures}) au mandataire judiciaire (2 mois après la publication de l'ouverture : ${delai(2)})`);
        if (f.stockTotal > 0) actions.push(`récupérer les ${f.stockTotal} ex. en dépôt, qui vous appartiennent (au besoin, demande de revendication : ${delai(3)})`);
      }
      f.raisons.push({ type: 'procedure', texte: `⚖️ ${d.long} depuis le ${formatDateFr(p.date_jugement)} (BODACC) : ${actions.join(' ; ')}. Délais à confirmer avec votre comptable.` });
    }
    const ruptures = Object.keys(f.vendus).filter(isbn => (f.stock[isbn] || 0) === 0);
    if (ruptures.length) f.raisons.push({ type: 'rupture', texte: `📉 Rupture probable : ${ruptures.map(titre).join(', ')} (tout vendu)` });
    // Stock négatif : plus de ventes et de retours que de dépôts enregistrés, ce n'est pas une rupture mais une saisie à vérifier
    const negatifs = Object.keys(f.stock).filter(isbn => f.stock[isbn] < 0);
    if (negatifs.length) f.raisons.push({ type: 'verifier', texte: `⚠️ Stock à vérifier : ${negatifs.map(isbn => `${titre(isbn)} (${f.stock[isbn]} ex.)`).join(', ')}, plus de ventes et retours que de dépôts enregistrés (un dépôt manque probablement)` });
    if (f.datesFutures.length) {
      const dates = [...new Set(f.datesFutures.map(m => formatDateFr(m.date)))].join(', ');
      const lignes = [...new Set(f.datesFutures.map(m => m.ligne_excel).filter(Boolean))];
      f.raisons.push({ type: 'verifier', texte: `⚠️ Date dans le futur (${dates}) : faute de frappe ?${lignes.length ? ` Lignes ${lignes.join(', ')} du classeur.` : ''} Corrigez ou supprimez le mouvement dans l'historique.` });
    }
    const bas = Object.keys(f.vendus).filter(isbn => (f.stock[isbn] || 0) > 0 && f.stock[isbn] <= Math.max(1, (f.deposes[isbn] || 0) * GESTION_REGLES.partStockBas));
    if (bas.length) f.raisons.push({ type: 'reassort', texte: `🔁 Vend bien, stock bas : proposer un réassort (${bas.map(titre).join(', ')})` });
    if (f.stockTotal > 0 && sansContact > GESTION_REGLES.joursSansContact) {
      f.raisons.push({ type: 'contact', texte: f.dernierContact ? `Pas de contact depuis le ${formatDateFr(f.dernierContact)}` : 'Aucun contact daté' });
    }
    f.priorite = f.raisons.length ? Math.min(...f.raisons.map(r => ({ ferme: 0, procedure: 0, rupture: 1, reassort: 2, verifier: 3, contact: 4 })[r.type])) : 9;
    if (f.raisons.length && !(f.raisons.length === 1 && f.raisons[0].type === 'rupture' && f.stockTotal === 0 && sansContact <= GESTION_REGLES.joursSansContact)) aAppeler.push(f);
    if (f.ventesNonFacturees.length) aFacturer.push(f);
    for (const fa of f.facturesImpayees) {
      const echeance = fa.echeance || echeanceFacture(fa.date);
      impayes.push({ facture: fa, client: f, echeance, enRetard: !!echeance && echeance < today() });
    }
    f.mouvements.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    f.factures.sort((a, b) => (b.numero || '').localeCompare(a.numero || ''));
  }
  aAppeler.sort((a, b) => a.priorite - b.priorite || b.totalVentes - a.totalVentes || b.valeurStock - a.valeurStock);
  aFacturer.sort((a, b) => b.aFacturer - a.aFacturer);
  // Échéances dépassées d'abord (les plus anciennes en tête), puis dates inconnues, puis pas encore échues
  const rang = i => i.enRetard ? 0 : !i.echeance ? 1 : 2;
  impayes.sort((a, b) => rang(a) - rang(b) || (a.echeance || '').localeCompare(b.echeance || '') || (b.facture.montant_net_ht || 0) - (a.facture.montant_net_ht || 0));

  return {
    parPdv, titres, aAppeler, aFacturer, impayes,
    anomaliesOuvertes: anomalies.filter(a => a.statut !== 'traitee'),
    kpis: { stockEx, stockValeur, totalAFacturer, totalImpayes, nbImpayes: impayes.length, nbEnRetard: impayes.filter(i => i.enRetard).length, nbAppeler: aAppeler.length },
    vide: !Object.keys(pdvs).length
  };
}

// Dernier commentaire d'un client (repris des colonnes « Commentaire » du classeur, ou saisi ici)
function dernierCommentaireHtml(f) {
  const m = (f.mouvements || []).find(m => m.commentaire && String(m.commentaire).trim());
  if (!m) return '';
  const quand = m.date ? `${formatDateFr(m.date)}${m.date_approx ? ' environ' : ''}` : 'date inconnue';
  return `<div class="g-commentaire">💬 <strong>Dernier commentaire</strong> <span class="g-muted">(${quand}${m.periode ? ', ' + escapeHtml(m.periode) : ''})</span> : ${escapeHtml(m.commentaire)}</div>`;
}

// Point de vente relié à une fiche librairie de la prospection
function clientDeLibrairie(librairieId) {
  return Object.values(Suivi.collection('pdv')).find(p => p.librairie_id === librairieId && !p.supprime) || null;
}

/**
 * Chiffres clés (en haut) : la situation de l'activité
 */
function updateKpisGestion() {
  const g = calculGestion();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (g.vide) {
    set('kpi-stock-val', '—'); set('kpi-stock-sub', 'Aucune donnée de gestion');
    set('kpi-facturer-val', '—'); set('kpi-impayes-val', '—'); set('kpi-appeler-val', '—');
    return;
  }
  set('kpi-stock-val', `${g.kpis.stockEx} ex.`);
  set('kpi-stock-sub', `${euros(g.kpis.stockValeur)} HT chez ${[...g.parPdv.values()].filter(f => f.stockTotal > 0).length} points de vente`);
  set('kpi-facturer-val', euros(g.kpis.totalAFacturer));
  set('kpi-facturer-sub', `${g.aFacturer.length} client(s) avec des ventes non facturées`);
  set('kpi-impayes-val', euros(g.kpis.totalImpayes));
  set('kpi-impayes-sub', `${g.kpis.nbImpayes} facture(s) non payée(s), dont ${g.kpis.nbEnRetard} en retard`);
  set('kpi-appeler-val', `${g.kpis.nbAppeler}`);
  set('kpi-appeler-sub', `stock en dépôt, pas de contact depuis ${GESTION_REGLES.joursSansContact} jours`);
}

/**
 * Vue « Accueil » : ce qu'il y a à faire
 */
function renderAccueilView() {
  const box = document.getElementById('accueil-content');
  if (!box) return;
  const g = calculGestion();
  if (g.vide) {
    box.innerHTML = `<div class="g-empty">Aucune donnée de gestion pour l'instant. Elles apparaîtront ici après la reprise du classeur.</div>`;
    return;
  }
  const ligneClient = (f, detail, raisons) => `
    <button class="g-row" onclick="openClient('${escapeHtml(f.pdv.id)}')">
      <span class="g-row-main"><strong>${escapeHtml(f.pdv.nom)}</strong><span class="g-muted">${escapeHtml(f.pdv.ville || '')}</span>
        ${(raisons || []).filter(r => r.type !== 'contact').map(r => `<span class="g-raison g-raison-${r.type}">${escapeHtml(r.texte)}</span>`).join('')}</span>
      <span class="g-row-side">${detail}</span>
    </button>`;
  const contactTxt = f => f.dernierContact ? `dernier contact ${formatDateFr(f.dernierContact)}` : 'aucun contact daté';

  // Tri choisi pour chaque colonne (retenu sur cet appareil)
  const t = triAccueil();
  const parNom = (a, b) => (a.pdv.nom || '').localeCompare(b.pdv.nom || '', 'fr');
  const appeler = [...g.aAppeler];
  if (t.appeler === 'nom') appeler.sort(parNom);
  else if (t.appeler === 'contact') appeler.sort((a, b) => (a.dernierContact || '').localeCompare(b.dernierContact || ''));
  else if (t.appeler === 'stock') appeler.sort((a, b) => b.valeurStock - a.valeurStock);
  const facturer = [...g.aFacturer];
  if (t.facturer === 'nom') facturer.sort(parNom);
  const impayes = [...g.impayes];
  if (t.impayes === 'montant') impayes.sort((a, b) => (b.facture.montant_net_ht || 0) - (a.facture.montant_net_ht || 0));
  else if (t.impayes === 'nom') impayes.sort((a, b) => parNom(a.client, b.client));

  box.innerHTML = `
    <div class="g-grid">
      <section class="g-card">
        <h3>📞 À appeler <span class="g-count">${g.aAppeler.length}</span>${selectTri('appeler')}</h3>
        <p class="g-help">Par ordre d'urgence : librairie fermée ou en procédure collective, rupture probable, réassort à proposer, stock à vérifier, puis pas de contact depuis plus de ${GESTION_REGLES.joursSansContact} jours (tour mensuel).</p>
        ${appeler.slice(0, 50).map(f => ligneClient(f, `${f.stockTotal} ex. · ${euros(f.valeurStock)}<br><span class="g-muted">${contactTxt(f)}</span>`, f.raisons)).join('') || '<p class="g-muted">Personne à appeler.</p>'}
      </section>
      <section class="g-card">
        <h3>🧾 À facturer <span class="g-count">${g.aFacturer.length}</span>${selectTri('facturer')}</h3>
        <p class="g-help">Ventes déclarées par le libraire mais pas encore facturées.</p>
        ${facturer.map(f => ligneClient(f, `${euros(f.aFacturer)} HT<br><span class="g-muted">${f.ventesNonFacturees.reduce((s, m) => s + (m.qte || 0), 0)} ex.</span>`)).join('') || '<p class="g-muted">Rien à facturer.</p>'}
      </section>
      <section class="g-card">
        <h3>💶 Impayés <span class="g-count">${g.impayes.length}</span>${selectTri('impayes')}</h3>
        <p class="g-help">Factures non payées. Échéance : ${GESTION_REGLES.joursApresFinDeMois} jours fin de mois ; en orange, échéance dépassée (à relancer).</p>
        ${impayes.slice(0, 60).map(({ facture, client, echeance, enRetard }) => ligneClient(client,
          `${escapeHtml(facture.numero)} · ${facture.montant_net_ht != null ? euros(facture.montant_net_ht) : '<span class="data-check">montant ?</span>'}<br>
           <span class="${enRetard ? 'data-check' : 'g-muted'}">${echeance ? `${enRetard ? 'échue' : 'échéance'} le ${formatDateFr(echeance)}` : 'date de facture inconnue'}</span>`)).join('') || '<p class="g-muted">Aucun impayé.</p>'}
      </section>
    </div>
    ${typeof appelsHtml === 'function' ? appelsHtml() : ''}
    <section class="g-card g-wide">
      <h3>🎯 Prospects à démarcher en premier <button class="g-info" onclick="openRessemblanceInfo()" title="Comment est calculée la ressemblance ?">ⓘ</button></h3>
      <p class="g-help">Votre cible principale (librairies qui ne sont pas 100 % BD / Manga / Jeunesse, pas encore clientes), classée par ressemblance avec celles où vos livres se vendent le mieux. Survolez la note pour le détail.</p>
      ${(() => {
        const prospects = (typeof ressemblance === 'function' ? state.bookstores : [])
          .filter(b => b.statut_prospection === 'A_CONTACTER' && !isExclusivelyJBM(b))
          .map(b => ({ b, r: ressemblance(b) })).filter(x => x.r).sort((x, y) => y.r.score - x.r.score).slice(0, 15);
        return prospects.length ? `<div class="g-prospects">${prospects.map(({ b, r }) => `
          <button class="g-row" onclick="openDrawer(${b.id})">
            <span class="g-row-main"><strong>${escapeHtml(b.nom)}</strong><span class="g-muted">${escapeHtml(b.commune)} · ${escapeHtml(b.region)}${b.email ? ' · email connu' : b.telephone ? ' · téléphone connu' : ''}</span></span>
            <span class="g-row-side">${ressemblanceBadge(b)}</span>
          </button>`).join('')}</div>
          <p style="margin-top:0.5rem;"><button class="btn btn-secondary btn-sm" onclick="voirTousProspects()">Voir tous les prospects classés</button></p>`
          : '<p class="g-muted">Reliez vos clients à leur fiche librairie pour obtenir des suggestions.</p>';
      })()}
    </section>
    <section class="g-card g-wide">
      <h3>⚠️ À vérifier <span class="g-count">${g.anomaliesOuvertes.length}</span></h3>
      <p class="g-help">Incohérences trouvées en reprenant le classeur Excel (rien n'a été corrigé à votre place). Cochez « Traité » une fois vérifié.</p>
      <details ${g.anomaliesOuvertes.length && g.anomaliesOuvertes.length < 15 ? 'open' : ''}>
        <summary>Afficher la liste</summary>
        ${g.anomaliesOuvertes.filter(a => a.gravite === 'a_verifier').concat(g.anomaliesOuvertes.filter(a => a.gravite !== 'a_verifier')).map(a => `
          <div class="g-anomalie">
            <span>${a.gravite === 'a_verifier' ? '⚠️' : 'ℹ️'} <strong>${escapeHtml(a.sujet)}</strong> — ${escapeHtml(a.message)}${a.ligne_excel ? ` <span class="g-muted">(ligne ${a.ligne_excel} du classeur)</span>` : ''}</span>
            <button class="btn btn-secondary btn-sm" onclick="traiterAnomalie('${escapeHtml(a.id)}')">Traité</button>
          </div>`).join('')}
      </details>
    </section>`;
}

// Tri des colonnes de l'Accueil
const TRIS_ACCUEIL = {
  appeler: { urgence: 'Par urgence', nom: 'Par nom', contact: 'Contact le plus ancien', stock: 'Valeur du stock' },
  facturer: { montant: 'Par montant', nom: 'Par nom' },
  impayes: { echeance: 'Par échéance', montant: 'Par montant', nom: 'Par nom' }
};
const TRI_ACCUEIL_KEY = 'biblio_tri_accueil';

function triAccueil() {
  const defaut = { appeler: 'urgence', facturer: 'montant', impayes: 'echeance' };
  try { return { ...defaut, ...JSON.parse(localStorage.getItem(TRI_ACCUEIL_KEY) || '{}') }; } catch (e) { return defaut; }
}

function changerTriAccueil(col, valeur) {
  const t = triAccueil();
  t[col] = valeur;
  try { localStorage.setItem(TRI_ACCUEIL_KEY, JSON.stringify(t)); } catch (e) { /* tri non retenu, sans conséquence */ }
  renderAccueilView();
}

function selectTri(col) {
  const t = triAccueil();
  return `<select class="g-tri" onchange="changerTriAccueil('${col}', this.value)" title="Trier cette colonne">${Object.entries(TRIS_ACCUEIL[col]).map(([k, l]) => `<option value="${k}" ${t[col] === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function traiterAnomalie(id) {
  const a = Suivi.collection('anomalies')[id];
  if (!a) return;
  Suivi.put('anomalies', id, { ...a, statut: 'traitee', traitee_le: today() });
  renderAccueilView();
}

/**
 * Vue « Clients » : tous les points de vente avec leur situation
 */
function renderClientsView() {
  const box = document.getElementById('clients-content');
  if (!box) return;
  const g = calculGestion();
  const q = (document.getElementById('clients-search')?.value || '').trim().toLowerCase();
  const list = [...g.parPdv.values()]
    .concat(Object.values(Suivi.collection('pdv')).filter(p => !p.supprime && !g.parPdv.has(p.id)).map(p => ({ pdv: p, stockTotal: 0, valeurStock: 0, totalVentes: 0, aFacturer: 0, impayes: 0, dernierContact: null })))
    .filter(f => !q || [f.pdv.nom, ...(f.pdv.noms || []), f.pdv.ville].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.valeurStock - a.valeurStock || (a.pdv.nom || '').localeCompare(b.pdv.nom || '', 'fr'));
  const searchValue = document.getElementById('clients-search')?.value || '';
  const propositions = q ? [] : propositionsRapprochement();
  box.innerHTML = `
    ${propositions.length ? `
    <section class="g-card" style="margin-bottom:1rem;">
      <h3>🔗 Clients à relier à leur fiche librairie <span class="g-count">${propositions.length}</span></h3>
      <p class="g-help">Fiches qui portent le même nom dans la même commune. Une fois reliée, la librairie passe en « Client actif » dans la prospection et compte pour la ressemblance.</p>
      ${propositions.map(({ pdv, candidats }) => `
        <div class="g-facture">
          <span><strong>${escapeHtml(pdv.nom)}</strong> <span class="g-muted">${escapeHtml(pdv.ville || '')}</span></span>
          <span class="g-facture-actions">
            ${candidats.map(b => `<button class="btn btn-primary btn-sm" onclick="relierLibrairie('${escapeHtml(pdv.id)}', ${b.id})" title="${escapeHtml(b.adresse || '')}">Relier à ${escapeHtml(b.nom)} (${escapeHtml(b.commune)})</button>`).join('')}
            <button class="btn btn-secondary btn-sm" onclick="refuserRapprochement('${escapeHtml(pdv.id)}', [${candidats.map(b => b.id).join(',')}])">${candidats.length > 1 ? 'Aucune des deux' : 'Ce n\'est pas elle'}</button>
          </span>
        </div>`).join('')}
    </section>` : ''}
    <div class="g-toolbar">
      <input type="search" id="clients-search" class="form-control" placeholder="Rechercher un client…" value="${escapeHtml(searchValue)}" oninput="renderClientsView()">
      <button class="btn btn-primary" onclick="openNouveauClient()">+ Nouveau client</button>
      <span class="g-muted">${list.length} client(s)</span>
    </div>
    <div class="table-container">
      <table class="crm-table">
        <thead><tr><th>Client</th><th>En dépôt</th><th>Ventes (total)</th><th>À facturer</th><th>Impayés</th><th>Dernier contact</th></tr></thead>
        <tbody>
          ${list.map(f => `
            <tr onclick="openClient('${escapeHtml(f.pdv.id)}')" style="cursor:pointer;">
              <td><strong>${escapeHtml(f.pdv.nom)}</strong>${f.pdv.librairie_id ? ' <span class="badge-specialty-mini">fiche librairie</span>' : ''}<div class="g-muted">${escapeHtml(f.pdv.ville || '')}</div></td>
              <td>${f.stockTotal ? `${f.stockTotal} ex.<div class="g-muted">${euros(f.valeurStock)}</div>` : '<span class="g-muted">—</span>'}</td>
              <td>${f.totalVentes || '<span class="g-muted">—</span>'}</td>
              <td>${f.aFacturer ? euros(f.aFacturer) : '<span class="g-muted">—</span>'}</td>
              <td>${f.impayes ? `<span class="data-check">${euros(f.impayes)}</span>` : '<span class="g-muted">—</span>'}</td>
              <td>${f.dernierContact ? formatDateFr(f.dernierContact) : '<span class="g-muted">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  const input = document.getElementById('clients-search');
  if (input && q) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

/**
 * Fiche client (dans le tiroir latéral)
 */
function openClient(pid) {
  const g = calculGestion();
  const pdv = Suivi.collection('pdv')[pid];
  if (!pdv) return;
  const f = g.parPdv.get(pid) || { pdv, stock: {}, stockTotal: 0, valeurStock: 0, mouvements: [], factures: [], ventesNonFacturees: [], aFacturer: 0, commission: pdv.commission ?? GESTION_REGLES.commissionParDefaut };
  state.selectedBookstore = null;
  state.selectedClient = pid;

  document.getElementById('drawer-title').textContent = pdv.nom;
  const lib = pdv.librairie_id ? state.bookstores.find(b => b.id === pdv.librairie_id) : null;
  document.getElementById('drawer-sub').innerHTML = `
    🤝 Client ${pdv.ville ? '· ' + escapeHtml(pdv.ville) : ''}
    ${lib ? ` · <a href="#" onclick="openDrawer(${lib.id}); return false;" style="color:var(--text-cyan);">Voir la fiche librairie ↗</a>` : ''}`;

  const titres = g.titres;
  const stockRows = Object.entries(f.stock).filter(([, q]) => q !== 0).map(([isbn, q]) => `
    <tr><td>${escapeHtml(titres[isbn]?.titre || isbn)}</td><td style="text-align:right;${q < 0 ? 'color:var(--accent-rose);' : ''}"${q < 0 ? ' title="Stock à vérifier : plus de ventes et de retours que de dépôts enregistrés (un dépôt manque probablement, ou une saisie est en double)"' : ''}>${q} ex.${q < 0 ? ' ⚠️ à vérifier' : ''}</td></tr>`).join('');

  document.getElementById('drawer-content-body').innerHTML = `
    ${dernierCommentaireHtml(f) ? `<div class="drawer-section">${dernierCommentaireHtml(f)}</div>` : ''}
    <div class="drawer-section">
      <h3>📦 Stock chez ce client</h3>
      ${stockRows ? `<table class="g-table">${stockRows}<tr><td><strong>Total</strong></td><td style="text-align:right;"><strong>${f.stockTotal} ex. · ${euros(f.valeurStock)} HT</strong></td></tr></table>`
        : '<p class="g-muted">Aucun exemplaire en dépôt.</p>'}
      <p class="g-muted" style="font-size:0.72rem;">Calculé à partir des dépôts, ventes déclarées et retours ci-dessous.</p>
    </div>

    <div class="drawer-section">
      <h3>✍️ Enregistrer</h3>
      <div class="g-actions">
        <button class="btn btn-secondary" onclick="formMouvement('${pid}', 'depot')">📦 Dépôt</button>
        <button class="btn btn-secondary" onclick="formMouvement('${pid}', 'vente')">💰 Ventes déclarées</button>
        <button class="btn btn-secondary" onclick="formMouvement('${pid}', 'retour')">↩️ Retour</button>
        <button class="btn btn-secondary" onclick="formMouvement('${pid}', 'appel')">📞 Appel / note</button>
      </div>
      <div id="g-form"></div>
    </div>

    <div class="drawer-section">
      <h3>🧾 Factures</h3>
      ${f.ventesNonFacturees.length ? `
        <div class="g-alert">
          ${f.ventesNonFacturees.reduce((s, m) => s + (m.qte || 0), 0)} exemplaire(s) vendu(s) non facturé(s) : <strong>${euros(f.aFacturer)} HT</strong>
          (commission ${Math.round(f.commission * 100)} %).
          <button class="btn btn-primary btn-sm" onclick="creerFacture('${pid}')">Créer la facture</button>
        </div>` : ''}
      <p class="g-muted" style="font-size:0.72rem;">Numéro d'une nouvelle facture : le plus grand numéro de l'année + 1 (FF${today().slice(2, 4)}-…). « Modifier » permet de corriger la date, le montant ou le paiement, ou d'annuler une facture.</p>
      <div id="g-facture-form"></div>
      ${f.factures.map(fa => `
        <div class="g-facture">
          <span><strong>${escapeHtml(fa.numero)}</strong> · ${fa.montant_net_ht != null ? euros(fa.montant_net_ht) + ' HT' : '<span class="data-check">montant à compléter</span>'}
            <span class="g-muted">· ${fa.date ? formatDateFr(fa.date) : 'date inconnue'}${!fa.payee && (fa.echeance || echeanceFacture(fa.date)) ? ` · échéance ${formatDateFr(fa.echeance || echeanceFacture(fa.date))}` : ''}</span>
            ${fa.controle ? `<div class="data-check" style="font-size:0.72rem;">${escapeHtml(fa.controle)}</div>` : ''}</span>
          <span class="g-facture-actions">
            ${fa.payee ? `<span class="lvl lvl-verifie">✅ Payée${fa.date_paiement ? ' le ' + formatDateFr(fa.date_paiement) : ''}</span>`
              : `<button class="btn btn-secondary btn-sm" onclick="formFacture('${escapeHtml(fa.numero)}', 'payer')">Marquer payée</button>`}
            <button class="btn btn-secondary btn-sm" onclick="formFacture('${escapeHtml(fa.numero)}', 'modifier')" title="Corriger la date, le montant, le paiement, ou annuler la facture">Modifier</button>
          </span>
        </div>`).join('') || '<p class="g-muted">Aucune facture.</p>'}
    </div>

    <div class="drawer-section">
      <h3>🕑 Historique</h3>
      ${f.mouvements.map(m => `
        <div class="g-mvt">
          <span class="g-mvt-date">${m.date ? formatDateFr(m.date) : '—'}${m.date_approx ? '<span class="data-check" title="Date exacte inconnue : fin de période retenue lors de la reprise"> ≈</span>' : ''}</span>
          <span>${MVT_TYPES[m.type]?.icon || ''} <strong>${MVT_TYPES[m.type]?.label || m.type}</strong>
            ${m.qte ? ` · ${m.qte} ex.` : ''}${m.titre ? ` · ${escapeHtml(m.titre)}` : ''}
            ${m.piece ? ` <span class="g-muted">${escapeHtml(m.piece)}</span>` : ''}${m.facture ? ` <span class="g-muted">→ ${escapeHtml(m.facture)}</span>` : ''}
            ${m.commentaire ? `<div class="g-muted">${escapeHtml(m.commentaire)}</div>` : ''}</span>
          <span class="g-mvt-actions">
            ${MVT_TYPES[m.type] ? `<button class="g-del" title="Modifier ce mouvement (date, quantité, commentaire)" onclick="formMouvement('${escapeHtml(m.pdv)}', '${m.type}', '${escapeHtml(m.id)}')">✎</button>` : ''}
            <button class="g-del" title="Supprimer ce mouvement" onclick="supprimerMouvement('${escapeHtml(m.id)}')">✕</button>
          </span>
        </div>`).join('') || '<p class="g-muted">Aucun mouvement.</p>'}
    </div>

    <div class="drawer-section">
      <h3>🔗 Fiche librairie</h3>
      ${pdv.librairie_id && state.baseById.get(pdv.librairie_id) ? `
        <p>Reliée à <a href="#" onclick="openDrawer(${pdv.librairie_id}); return false;" style="color:var(--text-cyan);">${escapeHtml(state.baseById.get(pdv.librairie_id).nom)} (${escapeHtml(state.baseById.get(pdv.librairie_id).commune)})</a>
        <button class="btn btn-secondary btn-sm" onclick="relierLibrairie('${pid}', null)">Délier</button></p>`
        : `<p class="g-muted" style="font-size:0.75rem;">Pas encore reliée. Relier ce client à sa fiche permet de l'afficher dans la prospection et d'en tenir compte pour la ressemblance.</p>
        <input class="form-control" id="g-lien-q" placeholder="Nom de la librairie ou commune…" value="${escapeHtml(pdv.nom)}" oninput="chercherLibrairie('${pid}')">
        <div id="g-lien-res"></div>`}
    </div>

    <div class="drawer-section">
      <h3>🔀 Doublon ?</h3>
      <p class="g-muted" style="font-size:0.75rem;">Si ce client existe deux fois, fusionnez-le avec l'autre fiche : dépôts, ventes et factures sont regroupés.</p>
      <select class="form-control" id="g-fusion-cible">
        <option value="">Choisir le client à garder…</option>
        ${Object.values(Suivi.collection('pdv')).filter(p => !p.supprime && p.id !== pid).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
          .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.nom)}${p.ville ? ' (' + escapeHtml(p.ville) + ')' : ''}</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" style="margin-top:0.4rem;" onclick="fusionnerClients('${pid}', document.getElementById('g-fusion-cible').value)">Fusionner dans le client choisi</button>
    </div>

    <div class="drawer-section">
      <h3>📇 Coordonnées</h3>
      ${['telephone', 'email', 'contact', 'adresse', 'code_postal', 'ville'].map(k => `
        <div class="form-group"><label>${{ telephone: 'Téléphone', email: 'Email', contact: 'Interlocuteur', adresse: 'Adresse', code_postal: 'Code postal', ville: 'Ville' }[k]}</label>
          <input class="form-control" data-pdv-field="${k}" value="${escapeHtml(pdv[k] || '')}" onchange="majClient('${pid}', this)"></div>`).join('')}
      <div class="form-group"><label>Commission du libraire (%)</label>
        <input class="form-control" type="number" min="0" max="100" step="1" data-pdv-field="commission" value="${pdv.commission != null ? Math.round(pdv.commission * 100) : ''}" placeholder="${Math.round(GESTION_REGLES.commissionParDefaut * 100)} (par défaut)" onchange="majClient('${pid}', this)"></div>
      ${(pdv.noms || []).length > 1 ? `<p class="g-muted" style="font-size:0.72rem;">Aussi écrit dans le classeur : ${escapeHtml(pdv.noms.filter(n => n !== pdv.nom).join(', '))}</p>` : ''}
    </div>`;
  setDrawerSaveHint('Chaque action est enregistrée automatiquement');
  document.getElementById('drawer-backdrop').classList.add('active');
  saveUiState();
}

function majClient(pid, input) {
  const pdv = Suivi.collection('pdv')[pid];
  if (!pdv) return;
  const k = input.getAttribute('data-pdv-field');
  let v = input.value.trim();
  if (k === 'commission') v = v === '' ? null : Math.min(100, Math.max(0, parseFloat(v))) / 100;
  Suivi.put('pdv', pid, { ...pdv, [k]: v });
  setDrawerSaveHint('✓ Enregistré automatiquement');
  refreshGestion(false);
}

// Prochain numéro de pièce : BL-26-001, BR-26-001, FF26-001…
function prochainNumero(prefixe) {
  const aa = today().slice(2, 4);
  const re = prefixe === 'FF' ? new RegExp(`^FF${aa}-(\\d+)`) : new RegExp(`^${prefixe}-?${aa}-(\\d+)`);
  let max = 0;
  const scan = s => { const m = re.exec(s || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); };
  actifs(Suivi.collection('mouvements')).forEach(m => { scan(m.piece); scan(m.depot_initial); scan(m.facture); });
  actifs(Suivi.collection('factures')).forEach(f => scan(f.numero));
  const n = String(max + 1).padStart(3, '0');
  return prefixe === 'FF' ? `FF${aa}-${n}` : `${prefixe}-${aa}-${n}`;
}

// Formulaire de saisie d'un mouvement ; avec mvtId, modification d'un mouvement existant (date, quantité, commentaire…)
function formMouvement(pid, type, mvtId) {
  const titres = Object.values(Suivi.collection('titres')).filter(t => !t.supprime).sort((a, b) => a.titre.localeCompare(b.titre, 'fr'));
  const m = mvtId ? Suivi.collection('mouvements')[mvtId] : null;
  const avecTitre = ['depot', 'vente', 'retour'].includes(type);
  const piece = m ? (m.piece || '') : type === 'depot' ? prochainNumero('BL') : type === 'retour' ? prochainNumero('BR') : '';
  const box = document.getElementById('g-form');
  box.innerHTML = `
    <div class="g-form">
      <strong>${MVT_TYPES[type].icon} ${m ? 'Modifier : ' : ''}${MVT_TYPES[type].label}</strong>
      <div class="g-form-grid">
        <label>Date <input type="date" id="gf-date" class="form-control" value="${escapeHtml(m ? (m.date || '') : today())}"></label>
        ${avecTitre ? `
          <label>Titre <select id="gf-titre" class="form-control">${titres.map(t => `<option value="${escapeHtml(t.isbn)}" ${m && m.isbn === t.isbn ? 'selected' : ''}>${escapeHtml(t.titre)}</option>`).join('')}</select></label>
          <label>Exemplaires <input type="number" id="gf-qte" class="form-control" min="1" step="1" value="${m ? (m.qte || 1) : 1}"></label>` : ''}
        ${piece || (m && avecTitre) ? `<label>N° de bon <input id="gf-piece" class="form-control" value="${escapeHtml(piece)}"></label>` : ''}
      </div>
      <label>Commentaire <input id="gf-comm" class="form-control" placeholder="Facultatif" value="${escapeHtml(m ? (m.commentaire || '') : '')}"></label>
      ${m && m.facture ? `<p class="g-muted" style="font-size:0.72rem;">Ces ventes figurent sur la facture ${escapeHtml(m.facture)} : la facture elle-même n'est pas modifiée.</p>` : ''}
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.5rem;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('g-form').innerHTML=''">Annuler</button>
        <button class="btn btn-primary btn-sm" onclick="enregistrerMouvement('${pid}', '${type}'${m ? `, '${escapeHtml(m.id)}'` : ''})">Enregistrer</button>
      </div>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function enregistrerMouvement(pid, type, mvtId) {
  const v = id => (document.getElementById(id)?.value || '').trim();
  const isbn = v('gf-titre');
  const qte = parseInt(v('gf-qte'), 10);
  if (['depot', 'vente', 'retour'].includes(type) && !(qte > 0)) { showToast("Indiquez un nombre d'exemplaires."); return; }
  // Date obligatoire et réelle : jamais remplacée en silence par la date du jour
  const date = dateValide(v('gf-date'));
  if (!date) { showToast('Choisissez la date dans le calendrier.'); return; }
  const titre = Suivi.collection('titres')[isbn];
  const avant = mvtId ? Suivi.collection('mouvements')[mvtId] : null;
  const id = avant ? mvtId : 'mv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    ...(avant || { origine: 'outil' }),
    type, pdv: pid, date, isbn: isbn || undefined, titre: titre?.titre, qte: qte || undefined,
    piece: v('gf-piece') || undefined, commentaire: v('gf-comm') || undefined,
    prix_ht: type === 'vente' ? (avant && avant.isbn === isbn && avant.prix_ht != null ? avant.prix_ht : titre?.prix_ht) : undefined
  };
  if (avant && avant.date !== date) delete rec.date_approx; // date précisée à la main
  Suivi.put('mouvements', id, rec);
  showToast(`${MVT_TYPES[type].label} ${avant ? 'modifié(e)' : 'enregistré(e)'}.`);
  refreshGestion(true, pid);
}

function supprimerMouvement(id) {
  const m = Suivi.collection('mouvements')[id];
  if (!m || !confirm(`Supprimer ce mouvement (${MVT_TYPES[m.type]?.label || m.type}${m.qte ? ', ' + m.qte + ' ex.' : ''}) ? Il reste récupérable dans l'historique de la sauvegarde.`)) return;
  Suivi.put('mouvements', id, { ...m, supprime: true, supprime_le: today() });
  refreshGestion(true, m.pdv);
}

function creerFacture(pid) {
  const g = calculGestion();
  const f = g.parPdv.get(pid);
  if (!f || !f.ventesNonFacturees.length) return;
  const numero = prochainNumero('FF');
  const lignes = f.ventesNonFacturees.map(m => ({ isbn: m.isbn, titre: m.titre, qte: m.qte, prix_ht: m.prix_ht || g.titres[m.isbn]?.prix_ht || 0 }));
  const brut = lignes.reduce((s, l) => s + l.qte * l.prix_ht, 0);
  const net = Math.round(brut * (1 - f.commission) * 100) / 100;
  if (!confirm(`Créer la facture ${numero} pour ${f.pdv.nom} : ${lignes.reduce((s, l) => s + l.qte, 0)} ex., ${euros(net)} HT (commission ${Math.round(f.commission * 100)} %) ?`)) return;
  Suivi.put('factures', numero, {
    numero, pdv: pid, date: today(), echeance: echeanceFacture(today()), annee: parseInt(today().slice(0, 4), 10), lignes,
    montant_brut_ht: Math.round(brut * 100) / 100, commission: f.commission, montant_net_ht: net,
    tva: Math.round(net * 0.055 * 100) / 100, montant_ttc: Math.round(net * 1.055 * 100) / 100, payee: false, origine: 'outil'
  });
  for (const m of f.ventesNonFacturees) Suivi.put('mouvements', m.id, { ...m, facture: numero });
  showToast(`Facture ${numero} créée.`);
  refreshGestion(true, pid);
}

// Date saisie dans un calendrier (AAAA-MM-JJ) : renvoie la date si elle existe vraiment, sinon null
function dateValide(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}

// Montant tapé à la française (« 153,94 », « 1 234,50 € ») : nombre, ou null si illisible
function montantValide(v) {
  const s = String(v || '').replace(/[\s €]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100) / 100;
}

// Montant net calculé d'après les lignes de la facture (à comparer avec la facture papier)
function montantDesLignes(fa) {
  if (!fa.lignes || !fa.lignes.length) return null;
  const pdv = Suivi.collection('pdv')[fa.pdv] || {};
  const commission = fa.commission ?? pdv.commission ?? GESTION_REGLES.commissionParDefaut;
  const brut = fa.lignes.reduce((s, l) => s + (l.qte || 0) * (l.prix_ht || 0), 0);
  return { net: Math.round(brut * (1 - commission) * 100) / 100, commission };
}

// Formulaire dans la fiche client : « payer » (date de paiement) ou « modifier » (date, montant, paiement, annulation)
function formFacture(numero, mode) {
  const fa = Suivi.collection('factures')[numero];
  const box = document.getElementById('g-facture-form');
  if (!fa || !box) return;
  const calc = montantDesLignes(fa);
  const n = escapeHtml(numero);
  box.innerHTML = mode === 'payer' ? `
    <div class="g-form">
      <strong>✅ Paiement de la facture ${n}</strong>
      <div class="g-form-grid">
        <label>Date du paiement <input type="date" id="gff-paiement" class="form-control" value="${today()}"></label>
      </div>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.5rem;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('g-facture-form').innerHTML=''">Annuler</button>
        <button class="btn btn-primary btn-sm" onclick="enregistrerFacture('${n}', 'payer')">Enregistrer</button>
      </div>
    </div>` : `
    <div class="g-form">
      <strong>✏️ Facture ${n}</strong>
      <div class="g-form-grid">
        <label>Date de la facture <input type="date" id="gff-date" class="form-control" value="${escapeHtml(fa.date || '')}"></label>
        <label>Montant net HT (€) <input type="text" inputmode="decimal" id="gff-montant" class="form-control" value="${fa.montant_net_ht != null ? String(fa.montant_net_ht).replace('.', ',') : ''}" placeholder="ex. 153,94"></label>
      </div>
      ${calc ? `<p class="g-muted" style="font-size:0.72rem;">D'après les lignes de la facture : ${euros(calc.net)} HT (commission ${Math.round(calc.commission * 100)} %). Vérifiez sur votre facture avant de reporter ce montant.</p>` : ''}
      <div class="g-form-grid">
        <label style="flex-direction:row;align-items:center;gap:0.4rem;"><input type="checkbox" id="gff-payee" ${fa.payee ? 'checked' : ''}> Payée</label>
        <label>Date du paiement <input type="date" id="gff-paiement" class="form-control" value="${escapeHtml(fa.date_paiement || '')}"></label>
      </div>
      <div style="display:flex;gap:0.5rem;justify-content:space-between;flex-wrap:wrap;margin-top:0.5rem;">
        <button class="btn btn-secondary btn-sm g-danger" onclick="annulerFacture('${n}')" title="Seulement pour une facture qui n'a pas été envoyée">🗑️ Annuler cette facture</button>
        <span style="display:flex;gap:0.5rem;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('g-facture-form').innerHTML=''">Fermer</button>
          <button class="btn btn-primary btn-sm" onclick="enregistrerFacture('${n}', 'modifier')">Enregistrer</button>
        </span>
      </div>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function enregistrerFacture(numero, mode) {
  const fa = Suivi.collection('factures')[numero];
  if (!fa) return;
  const v = id => (document.getElementById(id)?.value || '').trim();
  const next = { ...fa };
  if (mode === 'payer') {
    const p = dateValide(v('gff-paiement'));
    if (!p) { showToast('Choisissez la date du paiement dans le calendrier.'); return; }
    Object.assign(next, { payee: true, date_paiement: p });
  } else {
    const d = v('gff-date');
    if (d && !dateValide(d)) { showToast('Date de la facture invalide.'); return; }
    const montantTxt = v('gff-montant');
    const montant = montantTxt ? montantValide(montantTxt) : null;
    if (montantTxt && montant == null) { showToast('Montant illisible : tapez par exemple 153,94'); return; }
    const payee = !!document.getElementById('gff-payee')?.checked;
    const p = v('gff-paiement');
    if (payee && p && !dateValide(p)) { showToast('Date du paiement invalide.'); return; }
    if (d) Object.assign(next, { date: d, echeance: echeanceFacture(d), annee: parseInt(d.slice(0, 4), 10) });
    next.montant_net_ht = montant;
    if (montant != null && fa.origine === 'outil') {
      next.tva = Math.round(montant * 0.055 * 100) / 100;
      next.montant_ttc = Math.round(montant * 1.055 * 100) / 100;
    }
    next.payee = payee;
    if (payee) next.date_paiement = p || fa.date_paiement || null;
    else delete next.date_paiement;
  }
  Suivi.put('factures', numero, next);
  // Montant complété : le point « montant absent » de la reprise du classeur est réglé
  if (next.montant_net_ht != null && fa.montant_net_ht == null) {
    actifs(Suivi.collection('anomalies'))
      .filter(a => a.sujet === numero && a.statut !== 'traitee' && /montant/i.test(a.message || ''))
      .forEach(a => Suivi.put('anomalies', a.id, { ...a, statut: 'traitee', traitee_le: today(), traitee_par: 'montant saisi dans la facture' }));
  }
  showToast(`Facture ${numero} enregistrée.`);
  refreshGestion(true, fa.pdv);
}

// Annulation d'une facture créée par erreur : ses ventes redeviennent « à facturer » (récupérable dans l'historique)
function annulerFacture(numero) {
  const fa = Suivi.collection('factures')[numero];
  if (!fa) return;
  if (!confirm(`Annuler la facture ${numero} ?\n\nÀ faire seulement si elle n'a pas été envoyée au libraire : une facture envoyée s'annule par un avoir.\n\nLes ventes qu'elle contient redeviennent « à facturer ». Rien n'est perdu : la facture reste dans l'historique de la sauvegarde.`)) return;
  for (const m of actifs(Suivi.collection('mouvements')).filter(m => m.facture === numero)) {
    const { facture, ...reste } = m;
    Suivi.put('mouvements', m.id, reste);
  }
  Suivi.put('factures', numero, { ...fa, supprime: true, annulee: true, supprime_le: today() });
  showToast(`Facture ${numero} annulée : ses ventes sont de nouveau « à facturer ».`);
  refreshGestion(true, fa.pdv);
}

function openNouveauClient() {
  const nom = prompt('Nom du nouveau client (librairie, point de vente…) :');
  if (!nom || !nom.trim()) return;
  const id = 'pdv-' + Date.now().toString(36);
  Suivi.put('pdv', id, { nom: nom.trim(), noms: [nom.trim()], origine: 'outil' });
  refreshGestion(false);
  openClient(id);
}

const normTxt = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Recherche de la fiche librairie d'un client : par mots du nom ou de la commune, même département d'abord
function chercherLibrairie(pid) {
  const pdv = Suivi.collection('pdv')[pid];
  const q = normTxt(document.getElementById('g-lien-q')?.value).split(' ').filter(w => w.length > 2 && !['librairie', 'les', 'des', 'the'].includes(w));
  const box = document.getElementById('g-lien-res');
  if (!box) return;
  if (!q.length) { box.innerHTML = ''; return; }
  const dep = String(pdv.code_postal || pdv.departement || '').slice(0, 2);
  const res = state.bookstores.map(b => {
    const txt = normTxt([b.nom, ...(b.autres_noms || []), b.commune].join(' '));
    const hits = q.filter(w => txt.includes(w)).length;
    return { b, s: hits / q.length + (dep && b.code_postal.startsWith(dep) ? 0.3 : 0) };
  }).filter(x => x.s >= 0.5).sort((x, y) => y.s - x.s).slice(0, 6);
  box.innerHTML = res.map(({ b }) => `
    <div class="g-facture"><span>${escapeHtml(b.nom)} <span class="g-muted">${escapeHtml(b.commune)} (${escapeHtml(b.code_postal)})</span>${estClient(b.id) ? ' <span class="badge-client">déjà client</span>' : ''}</span>
      <button class="btn btn-primary btn-sm" onclick="relierLibrairie('${pid}', ${b.id})">Relier</button></div>`).join('') || '<p class="g-muted">Aucune librairie trouvée : essayez un autre mot ou la commune.</p>';
}

/**
 * Rapprochements proposés : client pas encore relié ↔ fiche librairie de même nom dans la même commune
 * (ou le même code postal). Testé sur les clients déjà reliés : la bonne fiche est retrouvée 49 fois sur 50,
 * la 50e étant un cas de deux librairies homonymes dans la même ville : on montre alors les deux.
 */
const MOTS_VIDES = new Set(['librairie', 'libraire', 'les', 'des', 'the', 'sur', 'aux', 'maison', 'presse', 'sas', 'sarl']);

function propositionsRapprochement() {
  const mots = s => normTxt(s).split(' ').filter(w => w.length > 2 && !MOTS_VIDES.has(w));
  const pris = new Set(actifs(Suivi.collection('pdv')).filter(p => p.librairie_id).map(p => p.librairie_id));
  const res = [];
  for (const pdv of actifs(Suivi.collection('pdv')).filter(p => !p.librairie_id)) {
    const ville = normTxt(pdv.ville);
    const cp = String(pdv.code_postal || '');
    const refuses = new Set(pdv.rapprochements_refuses || []);
    const listeMots = [pdv.nom, ...(pdv.noms || [])].map(mots).filter(m => m.length);
    if (!listeMots.length || (!ville && cp.length !== 5)) continue;
    const trouves = [];
    for (const b of state.bookstores) {
      if (pris.has(b.id) || refuses.has(b.id) || b.statut_prospection === 'FERMEE') continue;
      const commune = normTxt(b.commune);
      const memeLieu = (cp.length === 5 && b.code_postal === cp) || (ville && commune && (commune === ville || ` ${ville} `.includes(` ${commune} `) || ` ${commune} `.includes(` ${ville} `)));
      if (!memeLieu) continue;
      const txt = ` ${normTxt([b.nom, ...(b.autres_noms || []), b.nom_officiel].join(' '))} `;
      const part = Math.max(...listeMots.map(m => m.filter(w => txt.includes(` ${w} `)).length / m.length));
      if (part >= 0.6) trouves.push({ b, part });
    }
    if (!trouves.length) continue;
    trouves.sort((x, y) => y.part - x.part);
    // Deux fiches aussi ressemblantes l'une que l'autre : on laisse choisir
    const candidats = trouves.filter(x => x.part >= trouves[0].part - 0.01).slice(0, 2).map(x => x.b);
    res.push({ pdv, candidats });
  }
  return res;
}

function refuserRapprochement(pid, ids) {
  const pdv = Suivi.collection('pdv')[pid];
  if (!pdv) return;
  Suivi.put('pdv', pid, { ...pdv, rapprochements_refuses: [...new Set([...(pdv.rapprochements_refuses || []), ...ids])] });
  renderClientsView();
}

function relierLibrairie(pid, librairieId) {
  const pdv = Suivi.collection('pdv')[pid];
  if (!pdv) return;
  if (librairieId && estClient(librairieId) && estClient(librairieId).id !== pid) {
    if (!confirm('Cette librairie est déjà reliée à un autre client : c\'est peut-être un doublon (à fusionner). Relier quand même ?')) return;
  }
  Suivi.put('pdv', pid, { ...pdv, librairie_id: librairieId || null });
  state._clients = null; // cache des clients reliés
  showToast(librairieId ? 'Client relié à sa fiche librairie.' : 'Lien supprimé.');
  refreshGestion(true, pid);
  // Le statut « Client actif » des fiches librairies dépend des liens
  if (typeof applySuiviToAll === 'function') { applySuiviToAll(); applyFilters(); }
}

// Fusion de deux fiches client : tout ce qui concerne « source » passe sur « cible », la source est retirée
function fusionnerClients(sourceId, cibleId) {
  const pdvs = Suivi.collection('pdv');
  const src = pdvs[sourceId], dst = pdvs[cibleId];
  if (!src || !dst || sourceId === cibleId) { showToast('Choisissez le client à garder.'); return false; }
  if (!confirm(`Fusionner « ${src.nom} » dans « ${dst.nom} » ? Dépôts, ventes et factures de « ${src.nom} » passent sur « ${dst.nom} ». (Récupérable dans l'historique de la sauvegarde.)`)) return false;
  let n = 0;
  for (const m of Object.values(Suivi.collection('mouvements'))) if (m.pdv === sourceId) { Suivi.put('mouvements', m.id, { ...m, pdv: cibleId }); n++; }
  for (const fa of Object.values(Suivi.collection('factures'))) if (fa.pdv === sourceId) { Suivi.put('factures', fa.numero || fa.id, { ...fa, pdv: cibleId }); n++; }
  const merged = { ...dst, noms: [...new Set([...(dst.noms || [dst.nom]), ...(src.noms || [src.nom])])] };
  for (const k of ['telephone', 'email', 'contact', 'adresse', 'code_postal', 'ville', 'departement', 'site_web', 'horaires', 'commission', 'librairie_id']) {
    if ((merged[k] == null || merged[k] === '') && src[k] != null && src[k] !== '') merged[k] = src[k];
  }
  Suivi.put('pdv', cibleId, merged);
  Suivi.put('pdv', sourceId, { ...src, supprime: true, fusionne_dans: cibleId, supprime_le: today() });
  if (typeof state !== 'undefined') state._clients = null;
  showToast(`Fusion faite : ${n} élément(s) regroupé(s).`);
  refreshGestion(true, cibleId);
  return true;
}

// Rafraîchit chiffres clés, vues de gestion et, si demandé, la fiche client ouverte
function refreshGestion(reopen, pid) {
  updateKpisGestion();
  if (state.activeView === 'accueil') renderAccueilView();
  if (state.activeView === 'clients') renderClientsView();
  if (reopen && pid) openClient(pid);
}
