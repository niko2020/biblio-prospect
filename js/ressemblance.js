/**
 * BIBLIO-PROSPECT — Ressemblance avec les meilleurs clients (prospection)
 *
 * Pour chaque librairie qui n'est pas encore cliente, un indice de 0 à 100 : « ressemble-t-elle aux
 * librairies où les livres se vendent le mieux ? ». Il est calculé à partir des VENTES RÉELLES des
 * clients reliés à une fiche librairie.
 *
 * TOUS LES CRITÈRES SONT ICI, chacun avec son poids et son explication : l'info-bulle et la fenêtre
 * « Comment est-ce calculé ? » sont générées à partir de cette liste. Pour changer de méthode, on modifie,
 * ajoute ou retire un critère ici, et on augmente la version.
 */
const RESSEMBLANCE = {
  version: 1,
  date: '19/10/2026',
  minVentes: 5, // un client compte parmi les « meilleurs » à partir de ce nombre d'exemplaires vendus
  criteres: [
    {
      id: 'categories', label: 'Catégories', poids: 30,
      explication: "Les catégories de la librairie (liste officielle) comparées à celles des librairies où vos livres se vendent le mieux, pondérées par les exemplaires vendus.",
      cles: b => (b.categories && b.categories.length ? b.categories : [b.assortiment || 'Non précisé']),
      libelle: k => k
    },
    {
      id: 'region', label: 'Région', poids: 20,
      explication: "Les régions où vous vendez déjà le plus : clientèle qui vous connaît, démarchage en personne possible (Bretagne, Paris).",
      cles: b => [b.region || '—'],
      libelle: k => k
    },
    {
      id: 'taille', label: 'Taille de la ville', poids: 20,
      explication: "La population de la commune, comparée à celle des communes de vos meilleurs clients (indice grossier, à affiner).",
      cles: b => [b.population == null ? 'inconnue' : b.population < 5000 ? 'moins de 5 000 hab.' : b.population < 20000 ? '5 000 à 20 000 hab.' : b.population < 100000 ? '20 000 à 100 000 hab.' : 'plus de 100 000 hab.'],
      libelle: k => k
    },
    {
      id: 'label', label: 'Label', poids: 15,
      explication: "Le label du Ministère de la Culture (LIR : librairie indépendante de référence ; LR : librairie de référence), comparé à celui de vos meilleurs clients.",
      cles: b => [b.label_qualite === 'LIR' ? 'LIR' : b.label_qualite === 'LR' ? 'LR' : 'sans label'],
      libelle: k => k
    },
    {
      id: 'contact', label: 'Facilité de contact', poids: 15,
      explication: "Pas une ressemblance, mais un critère pratique : un email ou un téléphone connu permet de démarcher tout de suite (email : 100 %, téléphone seul : 60 %).",
      valeurFixe: b => (b.email ? 1 : b.telephone ? 0.6 : 0),
      detailFixe: b => (b.email ? 'email connu' : b.telephone ? 'téléphone seul' : 'aucun contact connu')
    }
  ]
};

let _profil = null, _profilAt = 0;

// Profil des meilleurs clients : pour chaque critère, la part des ventes par valeur (recalculé au plus toutes les 2 s)
function profilRessemblance() {
  const now = Date.now();
  if (_profil && now - _profilAt < 2000) return _profil;
  const ventes = {};
  Object.values(Suivi.collection('mouvements')).forEach(m => {
    if (!m.supprime && m.type === 'vente' && m.pdv) ventes[m.pdv] = (ventes[m.pdv] || 0) + (m.qte || 0);
  });
  const meilleurs = Object.values(Suivi.collection('pdv'))
    .filter(p => !p.supprime && p.librairie_id && (ventes[p.id] || 0) >= RESSEMBLANCE.minVentes && state.baseById.get(p.librairie_id))
    .map(p => ({ pdv: p, lib: state.baseById.get(p.librairie_id), ventes: ventes[p.id] }));
  const total = meilleurs.reduce((s, m) => s + m.ventes, 0) || 1;
  const parts = {};
  for (const c of RESSEMBLANCE.criteres.filter(c => c.cles)) {
    const p = {};
    for (const m of meilleurs) {
      const cles = c.cles(m.lib);
      cles.forEach(k => { p[k] = (p[k] || 0) + m.ventes / cles.length; });
    }
    Object.keys(p).forEach(k => { p[k] = p[k] / total; });
    parts[c.id] = { parts: p, max: Math.max(0, ...Object.values(p)) };
  }
  _profil = { meilleurs, totalVentes: total, parts };
  _profilAt = now;
  return _profil;
}

// Indice d'une librairie : { score 0-100, details par critère } ; null pour un client ou une librairie fermée
function ressemblance(b) {
  if (!b || estClient(b.id) || b.etablissement_ferme) return null;
  const prof = profilRessemblance();
  if (!prof.meilleurs.length) return null;
  let score = 0;
  const details = [];
  for (const c of RESSEMBLANCE.criteres) {
    let v, detail;
    if (c.valeurFixe) {
      v = c.valeurFixe(b);
      detail = c.detailFixe(b);
    } else {
      const { parts, max } = prof.parts[c.id];
      const best = c.cles(b).map(k => ({ k, part: parts[k] || 0 })).sort((x, y) => y.part - x.part)[0];
      v = max ? best.part / max : 0;
      detail = `${c.libelle(best.k)} : ${Math.round(best.part * 100)} % des ventes de vos meilleurs clients`;
    }
    const pts = Math.round(c.poids * v);
    score += pts;
    details.push({ critere: c, points: pts, detail });
  }
  return { score: Math.min(100, score), details };
}

function ressemblanceTexte(r) {
  return `Ressemblance avec vos meilleurs clients : ${r.score}/100\n` +
    r.details.map(d => `• ${d.critere.label} : ${d.points}/${d.critere.poids} (${d.detail})`).join('\n') +
    `\nCritères version ${RESSEMBLANCE.version} : cliquer sur ⓘ « Comment est-ce calculé ? » pour le détail.`;
}

// Petit badge 🎯 avec l'explication complète au survol
function ressemblanceBadge(b) {
  const r = ressemblance(b);
  if (!r) return '';
  const niveau = r.score >= 70 ? 'haut' : r.score >= 45 ? 'moyen' : 'bas';
  return `<span class="badge-ressemblance r-${niveau}" title="${escapeHtml(ressemblanceTexte(r))}">🎯 ${r.score}</span>`;
}

// Fenêtre « Comment est-ce calculé ? » : générée depuis RESSEMBLANCE et le profil réel
function openRessemblanceInfo() {
  const prof = profilRessemblance();
  let modal = document.getElementById('ressemblance-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ressemblance-modal';
    modal.className = 'modal-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
    document.body.appendChild(modal);
  }
  const top = (id, n = 4) => Object.entries(prof.parts[id]?.parts || {}).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${escapeHtml(k)} ${Math.round(v * 100)} %`).join(' · ');
  modal.innerHTML = `
    <div class="modal-card" style="max-width:720px;">
      <div class="modal-header">
        <h3 style="font-family:var(--font-heading);font-weight:700;">🎯 Comment est calculée la ressemblance ?</h3>
        <button class="drawer-close-btn" onclick="document.getElementById('ressemblance-modal').classList.remove('active')">✕</button>
      </div>
      <div class="modal-body">
        <p>Chaque librairie qui n'est pas encore cliente reçoit une note de 0 à 100 : plus elle est haute, plus la librairie
        ressemble à celles où vos livres se vendent le mieux. Critères <strong>version ${RESSEMBLANCE.version}</strong> (${RESSEMBLANCE.date}), appelés à évoluer.</p>
        <p class="g-muted">Calculé à partir de <strong>${prof.meilleurs.length} clients</strong> reliés à une fiche librairie et ayant vendu au moins ${RESSEMBLANCE.minVentes} exemplaires
        (${prof.totalVentes} ex. au total). Un client non relié à sa fiche librairie ne compte pas : reliez-le depuis sa fiche client.</p>
        <table class="g-table" style="margin:0.75rem 0;">
          <tr><td><strong>Critère</strong></td><td><strong>Poids</strong></td><td><strong>Ce qu'il mesure</strong></td></tr>
          ${RESSEMBLANCE.criteres.map(c => `<tr><td>${escapeHtml(c.label)}</td><td>${c.poids}</td><td>${escapeHtml(c.explication)}${c.cles ? `<div class="g-muted">Chez vos meilleurs clients : ${top(c.id)}</div>` : ''}</td></tr>`).join('')}
        </table>
        <p class="g-muted">Les clients, les librairies fermées et les fiches sans données ne reçoivent pas de note.</p>
      </div>
    </div>`;
  modal.classList.add('active');
}
