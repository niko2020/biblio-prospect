/**
 * BIBLIO-PROSPECT — Appels de prospection : liste du jour et planification
 *
 * Un appel prévu = une fiche librairie avec une date de « prochaine action » (champ déjà présent dans
 * chaque fiche). Le planificateur répartit les prospects choisis sur les prochains jours ouvrés
 * (N par jour) ; « ✓ Appelé » note l'appel, « Demain » le reporte au jour ouvré suivant.
 * Les dates posées par le planificateur sont marquées « relance_auto » pour pouvoir être retirées d'un coup.
 */
const APPELS = { parJourDefaut: 5, joursDefaut: 10, maxTotal: 100, aVenirJours: 7 };

const isoJour = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateLocale = iso => new Date(iso + 'T12:00:00');

// Jour ouvré (lundi à vendredi) : le jour même s'il l'est, sinon le suivant
function jourOuvre(d) {
  const x = new Date(d);
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() + 1);
  return x;
}
function jourOuvreSuivant(d) {
  const x = new Date(d);
  x.setDate(x.getDate() + 1);
  return jourOuvre(x);
}

function appelsHtml() {
  const auj = isoJour(new Date());
  const dans7 = isoJour(new Date(Date.now() + APPELS.aVenirJours * 86400000));
  const prevus = state.bookstores.filter(b => b.date_relance && b.statut_prospection !== 'FERMEE');
  const dus = prevus.filter(b => b.date_relance <= auj).sort((a, b) => a.date_relance.localeCompare(b.date_relance) || (a.nom || '').localeCompare(b.nom || '', 'fr'));
  const aVenir = prevus.filter(b => b.date_relance > auj && b.date_relance <= dans7).length;
  const auto = Object.values(Suivi.all()).filter(e => e.relance_auto && e.date_relance).length;
  const ligne = b => {
    const retard = Math.round((dateLocale(auj) - dateLocale(b.date_relance)) / 86400000);
    const tel = safeTel(b.telephone);
    return `
      <div class="g-appel">
        <span class="g-row-main" onclick="openDrawer(${b.id})" style="cursor:pointer;">
          <strong>${escapeHtml(b.nom)}</strong><span class="g-muted">${escapeHtml(b.commune)} · ${formatStatusName(b.statut_prospection)}${retard > 0 ? ` · <span class="data-check">prévu le ${formatDateFr(b.date_relance)}</span>` : ''}</span>
          ${b.notes_prospection ? `<span class="g-muted" style="font-size:0.72rem;">📝 ${escapeHtml(b.notes_prospection.slice(0, 120))}</span>` : ''}
        </span>
        <span class="g-facture-actions">
          ${tel ? `<a class="btn btn-secondary btn-sm" href="tel:${escapeHtml(tel.replace(/\s/g, ''))}">📞 ${escapeHtml(tel)}</a>` : '<span class="g-muted" style="font-size:0.72rem;">téléphone à récupérer</span>'}
          <button class="btn btn-primary btn-sm" onclick="marquerAppele(${b.id})" title="Note l'appel d'aujourd'hui ; ouvrez ensuite la fiche pour une note ou une relance">✓ Appelé</button>
          <button class="btn btn-secondary btn-sm" onclick="reporterAppel(${b.id})" title="Reporter au prochain jour ouvré">Demain</button>
        </span>
      </div>`;
  };
  return `
    <section class="g-card g-wide">
      <h3>📅 Mes appels de prospection <span class="g-count">${dus.length}</span></h3>
      <p class="g-help">Les librairies dont la date de « prochaine action » est aujourd'hui ou passée. ${aVenir ? `${aVenir} autre(s) prévu(s) dans les ${APPELS.aVenirJours} prochains jours.` : ''} Cliquez sur un nom pour ouvrir la fiche (notes, statut, prochaine relance).</p>
      ${dus.slice(0, 40).map(ligne).join('') || '<p class="g-muted">Aucun appel prévu aujourd\'hui.</p>'}
      ${dus.length > 40 ? `<p class="g-muted">… et ${dus.length - 40} autre(s).</p>` : ''}
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.6rem;">
        <button class="btn btn-secondary btn-sm" onclick="formPlanification()">🗓️ Planifier mes prochains appels</button>
        ${auto ? `<button class="btn btn-secondary btn-sm" onclick="retirerPlanification()" title="Retire les dates posées par le planificateur pour les librairies pas encore contactées">Retirer la planification automatique (${auto})</button>` : ''}
      </div>
      <div id="plan-form"></div>
    </section>`;
}

function formPlanification() {
  const box = document.getElementById('plan-form');
  if (!box) return;
  box.innerHTML = `
    <div class="g-form">
      <strong>🗓️ Planifier des appels</strong>
      <div class="g-form-grid">
        <label>Appels par jour <input type="number" id="pl-n" class="form-control" min="1" max="30" value="${APPELS.parJourDefaut}"></label>
        <label>Pendant (jours ouvrés) <input type="number" id="pl-j" class="form-control" min="1" max="40" value="${APPELS.joursDefaut}"></label>
        <label>À partir du <input type="date" id="pl-d" class="form-control" value="${isoJour(jourOuvre(new Date()))}"></label>
      </div>
      <label>Quelles librairies ?
        <select id="pl-source" class="form-control">
          <option value="cible">Ma cible principale, les plus ressemblantes à mes meilleurs clients d'abord</option>
          <option value="affichees">Celles affichées dans l'onglet Tableau (avec mes filtres), dans leur ordre</option>
        </select>
      </label>
      <label style="flex-direction:row;align-items:center;gap:0.4rem;"><input type="checkbox" id="pl-tel" checked> Seulement celles dont le téléphone est connu</label>
      <p class="g-muted" style="font-size:0.72rem;">Ne sont jamais planifiées : les clients, les librairies fermées, celles déjà contactées ou qui ont déjà une date prévue. Maximum ${APPELS.maxTotal} appels à la fois.</p>
      <div style="display:flex;gap:0.5rem;justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('plan-form').innerHTML=''">Annuler</button>
        <button class="btn btn-primary btn-sm" onclick="planifierAppels()">Planifier</button>
      </div>
    </div>`;
}

function planifierAppels() {
  const val = id => document.getElementById(id)?.value || '';
  const n = Math.min(30, Math.max(1, parseInt(val('pl-n'), 10) || 0));
  const j = Math.min(40, Math.max(1, parseInt(val('pl-j'), 10) || 0));
  const debut = dateValide(val('pl-d'));
  if (!debut) { showToast('Choisissez la date de début dans le calendrier.'); return; }
  const avecTel = !!document.getElementById('pl-tel')?.checked;
  const source = val('pl-source');
  const eligible = b => b.statut_prospection === 'A_CONTACTER' && !b.date_relance && !estClient(b.id) && (!avecTel || safeTel(b.telephone));
  let candidats;
  if (source === 'affichees') {
    candidats = (state.filteredBookstores || []).filter(eligible);
  } else {
    candidats = state.bookstores.filter(b => eligible(b) && !isExclusivelyJBM(b))
      .map(b => ({ b, s: (ressemblance(b) || { score: -1 }).score })).sort((x, y) => y.s - x.s).map(x => x.b);
  }
  const total = Math.min(n * j, APPELS.maxTotal, candidats.length);
  if (!total) { showToast('Aucune librairie à planifier avec ces critères.'); return; }
  const dates = [];
  let jour = jourOuvre(dateLocale(debut));
  for (let i = 0; i < total; i++) {
    if (i > 0 && i % n === 0) jour = jourOuvreSuivant(jour);
    dates.push(isoJour(jour));
  }
  if (!confirm(`Planifier ${total} appel(s), ${n} par jour, du ${formatDateFr(dates[0])} au ${formatDateFr(dates[dates.length - 1])} ?\n\nPremières librairies : ${candidats.slice(0, 3).map(b => b.nom).join(', ')}…`)) return;
  candidats.slice(0, total).forEach((b, i) => setSuivi(b.id, { date_relance: dates[i], relance_auto: true }));
  applyFilters();
  showToast(`${total} appel(s) planifié(s).`);
  renderAccueilView();
}

function retirerPlanification() {
  const entries = Suivi.all();
  const ids = Object.keys(entries).filter(k => entries[k].relance_auto && entries[k].date_relance)
    .map(Number).filter(id => (state.bookstores.find(b => b.id === id) || {}).statut_prospection === 'A_CONTACTER');
  if (!ids.length) { showToast('Rien à retirer : les librairies planifiées ont déjà été contactées.'); return; }
  if (!confirm(`Retirer la date prévue de ${ids.length} librairie(s) planifiée(s) automatiquement et pas encore contactée(s) ?`)) return;
  ids.forEach(id => setSuivi(id, { date_relance: '', relance_auto: false }));
  applyFilters();
  showToast(`${ids.length} appel(s) retiré(s) du planning.`);
  renderAccueilView();
}

function marquerAppele(id) {
  const b = state.bookstores.find(x => x.id === id);
  if (!b) return;
  setSuivi(id, {
    date_derniere_action: isoJour(new Date()), date_relance: '', relance_auto: false,
    statut_prospection: b.statut_prospection === 'A_CONTACTER' ? 'CONTACTE' : b.statut_prospection
  });
  applyFilters();
  showToast(`Appel à ${b.nom} noté (statut « ${formatStatusName(state.bookstores.find(x => x.id === id).statut_prospection)} »). Ouvrez la fiche pour une note ou une prochaine relance.`);
  renderAccueilView();
}

function reporterAppel(id) {
  const b = state.bookstores.find(x => x.id === id);
  if (!b) return;
  const base = b.date_relance && b.date_relance > isoJour(new Date()) ? dateLocale(b.date_relance) : new Date();
  setSuivi(id, { date_relance: isoJour(jourOuvreSuivant(base)) });
  applyFilters();
  renderAccueilView();
}
