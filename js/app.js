/**
 * BIBLIO-PROSPECT - Application Core Script
 * Prospection Commerciale dans l'univers de l'édition de livres
 * Référentiel des Librairies de Bretagne & France
 */

// État Global de l'Application
const state = {
  bookstores: [],
  filteredBookstores: [],
  selectedBookstore: null,
  activeView: 'accueil', // 'accueil', 'clients' (gestion) ; 'map', 'table', 'cards', 'kanban', 'analytics', 'france' (prospection)
  filters: {
    search: '',
    region: '53', // Bretagne par défaut (région pilote enrichie SIRENE)
    department: 'ALL',
    specialty: 'ALL',
    labelLir: 'ALL',
    status: 'ALL',
    priority: 'ALL',
    onlyFavorites: false,
    excludeJBM: false,
    joignable: 'ALL',
    sortBy: 'default'
  },
  mapInstance: null,
  markersLayer: null,
  needsFitBounds: false,
  sireneLive: null
};

// Initialisation au chargement du DOM
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  boot();
});

/**
 * Démarrage : sans clé d'accès, seul l'écran d'accueil s'affiche (aucune donnée dans la page publique).
 * Avec la clé : téléchargement des données depuis le dépôt privé, puis lancement de l'outil.
 */
async function boot(errorMessage) {
  if (!Acces.localMode && !Suivi.isConfigured()) {
    showGate(errorMessage);
    return;
  }
  showGate(null, true);
  try {
    const { data, horsLigne } = await Acces.load();
    window.LIBRAIRIES_META = data.meta;
    window.FRANCE_GEO = data.geo;
    window.LIBRAIRIES_DATA = data.librairies;
    if (Acces.localMode) {
      try { Suivi.loadSnapshot(await (await fetch('suivi.json', { cache: 'no-store' })).json()); } catch (e) { /* pas de suivi.json local */ }
    }
    hideGate();
    startApp();
    if (horsLigne) showToast("Hors ligne : données de votre dernière visite. Vos modifications seront envoyées au retour d'Internet.");
  } catch (e) {
    showGate(e.message);
  }
}

let appStarted = false;
function startApp() {
  if (appStarted) return;
  appStarted = true;
  initData();
  // Retour là où on en était (onglet, filtres, recherche, carte, fiche ouverte)
  const ui = restoreUiState();
  setupEventListeners();
  initStickyBars();
  syncControlsFromState();
  initSaveStatus();
  applyFilters();
  switchView(ui.view && document.getElementById(`view-${ui.view}`) ? ui.view : state.activeView);
  updateKpis();
  if (ui.ouverte && state.bookstores.some(b => b.id === ui.ouverte)) openDrawer(ui.ouverte);
  else if (ui.client && Suivi.collection('pdv')[ui.client]) openClient(ui.client);
  state.uiReady = true;
  saveUiState();
  surveillerNouvelleVersion();
  // Récupère la sauvegarde en ligne (autre appareil, navigateur réinitialisé...) puis rafraîchit l'affichage
  if (Suivi.isConfigured()) {
    Suivi.pull().then(changed => { if (changed && Suivi.onRemoteChange) Suivi.onRemoteChange(); });
  }
}

/**
 * Nouvelle version publiée pendant que l'outil est ouvert : un bandeau propose de rafraîchir.
 * La page publiée porte sa version (balise « version-outil ») et le fichier version.txt donne celle en ligne.
 * Rien à faire pour le dossier ouvert depuis l'ordinateur ni en test local (version « dev »).
 */
const VERSION_OUTIL = document.querySelector('meta[name="version-outil"]')?.content || 'dev';
const VERIF_VERSION_MS = 5 * 60 * 1000;

function surveillerNouvelleVersion() {
  if (VERSION_OUTIL === 'dev' || !/^https?:$/.test(location.protocol)) return;
  let signalee = false;
  const verifier = async () => {
    if (signalee) return;
    try {
      const res = await fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const enLigne = (await res.text()).trim();
      if (enLigne && enLigne !== VERSION_OUTIL) { signalee = true; afficherBandeauVersion(); }
    } catch (e) { /* hors ligne : on réessaiera */ }
  };
  setInterval(verifier, VERIF_VERSION_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') verifier(); });
  verifier();
}

function afficherBandeauVersion() {
  if (document.getElementById('bandeau-version')) return;
  const b = document.createElement('div');
  b.id = 'bandeau-version';
  b.className = 'bandeau-version';
  b.innerHTML = `<span>🔄 Une nouvelle version de l'outil est disponible. Vos données restent enregistrées.</span>
    <button type="button" class="btn">Rafraîchir</button>`;
  b.querySelector('button').addEventListener('click', rafraichirOutil);
  document.body.prepend(b);
}

// Enregistre tout (fiche ouverte, envoi en attente) avant de recharger la page
async function rafraichirOutil(e) {
  const btn = e && e.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }
  try {
    flushDrawer();
    saveUiState();
    if (Suivi.isConfigured() && Suivi.pendingCount()) await Promise.race([Suivi.push(), new Promise(r => setTimeout(r, 15000))]);
  } catch (err) { /* les données restent dans le navigateur et partiront au prochain chargement */ }
  location.reload();
}

function showGate(message, loading) {
  const gate = document.getElementById('gate');
  if (!gate) return;
  gate.classList.add('active');
  document.getElementById('gate-form').style.display = loading ? 'none' : '';
  document.getElementById('gate-loading').style.display = loading ? '' : 'none';
  const err = document.getElementById('gate-error');
  err.textContent = message || '';
  err.style.display = message ? '' : 'none';
  if (!loading) setTimeout(() => document.getElementById('gate-token')?.focus(), 50);
}

function hideGate() {
  document.getElementById('gate')?.classList.remove('active');
}

async function submitGate(event) {
  event.preventDefault();
  const token = document.getElementById('gate-token').value.trim();
  if (!token) return showGate("Collez votre clé d'accès.");
  showGate(null, true);
  const test = await Suivi.testConfig({ token });
  if (!test.ok) return showGate(test.message);
  boot();
}

/**
 * 1. Initialisation des Données
 */
/**
 * Charge le référentiel de base : Bretagne (enrichie SIRENE) + reste de la France
 * (liste officielle, localisée au centre de la commune), et rattache chaque librairie à sa région.
 */
function loadBaseBookstores() {
  let list = [];
  if (typeof LIBRAIRIES_DATA !== 'undefined') {
    list = LIBRAIRIES_DATA;
  } else {
    console.error("Données LIBRAIRIES_DATA non chargées.");
  }
  // Les données ne contiennent que des faits ; le suivi part de ces valeurs par défaut
  const CRM_DEFAULTS = { statut_prospection: 'A_CONTACTER', priorite: 'MOYENNE', is_favorite: false, contact_referent: '',
    notes_prospection: '', date_derniere_action: '', date_relance: '' };
  return JSON.parse(JSON.stringify(list)).map(b => ({ ...CRM_DEFAULTS, ...b }));
}

function initData() {
  state.baseById = new Map(loadBaseBookstores().map(b => [b.id, b]));
  // Fiches fusionnées par une mise à jour des données : le suivi enregistré sous un ancien
  // identifiant est rattaché à la fiche actuelle
  const aliasToMain = {};
  state.baseById.forEach(b => (b.alias_ids || []).forEach(a => { aliasToMain[a] = b.id; }));
  Suivi.remapAliases(aliasToMain);
  applySuiviToAll();
  applyFilters();
}

/**
 * Gestion des Favoris
 */
function toggleFavorite(bookstoreId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const bookstore = state.bookstores.find(b => b.id === bookstoreId);
  if (!bookstore) return;

  const updated = setSuivi(bookstoreId, { is_favorite: !bookstore.is_favorite });
  applyFilters();
  renderActiveView();
  updateKpis();

  const drawerFavBtn = document.getElementById('drawer-fav-btn');
  if (drawerFavBtn && state.selectedBookstore && state.selectedBookstore.id === bookstoreId) {
    drawerFavBtn.className = `btn btn-secondary btn-sm ${updated.is_favorite ? 'active' : ''}`;
    drawerFavBtn.innerHTML = updated.is_favorite ? '⭐ En favori' : '☆ Mettre en favori';
  }
  showToast(updated.is_favorite ? `⭐ "${updated.nom}" ajoutée aux favoris.` : `☆ "${updated.nom}" retirée des favoris.`);
}

/**
 * 2. Gestion du Thème (Dark / Light)
 */
function initTheme() {
  const savedTheme = localStorage.getItem('biblio_prospect_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('biblio_prospect_theme', newTheme);
  updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
  const cornerDark = document.getElementById('corner-theme-dark');
  const cornerLight = document.getElementById('corner-theme-light');
  if (cornerDark && cornerLight) {
    cornerDark.style.color = theme === 'dark' ? 'var(--text-gold)' : 'var(--text-muted)';
    cornerDark.style.fontWeight = theme === 'dark' ? '700' : '400';
    cornerLight.style.color = theme === 'light' ? 'var(--accent-gold)' : 'var(--text-muted)';
    cornerLight.style.fontWeight = theme === 'light' ? '700' : '400';
  }
}

/**
 * 3. Configuration des Écouteurs d'Événements
 */
function setupEventListeners() {
  // Recherche textuelle
  const searchInput = document.getElementById('global-search-input');
  const searchClear = document.getElementById('search-clear-btn');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.filters.search = e.target.value.trim().toLowerCase();
      if (searchClear) searchClear.style.display = state.filters.search ? 'block' : 'none';
      applyFilters();
      renderActiveView();
      updateKpis();
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      state.filters.search = '';
      searchClear.style.display = 'none';
      applyFilters();
      renderActiveView();
      updateKpis();
    });
  }

  // Raccourci clavier "/" ou "Ctrl+K" pour focus la recherche
  window.addEventListener('keydown', (e) => {
    if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && document.activeElement !== searchInput) {
      e.preventDefault();
      if (searchInput) searchInput.focus();
    }
    if (e.key === 'Escape') {
      closeDrawer();
      closeGuideModal();
    }
  });

  // Sélecteurs de filtre
  populateSpecialtySelect();
  populateRegionSelect();
  populateDepartmentSelect();

  const filterRegion = document.getElementById('filter-region');
  if (filterRegion) {
    filterRegion.addEventListener('change', (e) => {
      state.filters.region = e.target.value;
      state.filters.department = 'ALL';
      populateDepartmentSelect();
      state.needsFitBounds = true;
      applyFilters();
      renderActiveView();
      updateKpis();
    });
  }

  const filterDept = document.getElementById('filter-department');
  if (filterDept) {
    filterDept.addEventListener('change', (e) => {
      state.filters.department = e.target.value;
      state.needsFitBounds = true;
      applyFilters();
      renderActiveView();
      updateKpis();
    });
  }

  const filterSpecialty = document.getElementById('filter-specialty');
  if (filterSpecialty) {
    filterSpecialty.addEventListener('change', (e) => {
      state.filters.specialty = e.target.value;
      applyFilters();
      renderActiveView();
      updateKpis();
    });
  }

  const filterStatus = document.getElementById('filter-status');
  if (filterStatus) {
    filterStatus.addEventListener('change', (e) => {
      state.filters.status = e.target.value;
      applyFilters();
      renderActiveView();
      updateKpis();
    });
  }

  const filterSort = document.getElementById('filter-sort');
  if (filterSort) {
    filterSort.addEventListener('change', (e) => {
      state.filters.sortBy = e.target.value;
      state.triAuto = false;
      applyFilters();
      renderActiveView();
    });
  }

  // Tags d'accès rapide
  document.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const filterType = chip.getAttribute('data-filter-type');
      const filterVal = chip.getAttribute('data-filter-val');

      if (filterType === 'onlyFavorites') {
        state.filters.onlyFavorites = !state.filters.onlyFavorites;
        chip.classList.toggle('active', state.filters.onlyFavorites);
      } else if (filterType === 'excludeJBM') {
        state.filters.excludeJBM = !state.filters.excludeJBM;
        chip.classList.toggle('active', state.filters.excludeJBM);
        // Cible principale = filtre (qui garder) ; la ressemblance classe ensuite (dans quel ordre),
        // sauf si un autre tri a été choisi
        if (state.filters.excludeJBM && state.filters.sortBy === 'default') {
          state.filters.sortBy = 'ressemblance_desc';
          state.triAuto = true;
        } else if (!state.filters.excludeJBM && state.triAuto && state.filters.sortBy === 'ressemblance_desc') {
          state.filters.sortBy = 'default';
          state.triAuto = false;
        }
        const sortSel = document.getElementById('filter-sort');
        if (sortSel) sortSel.value = state.filters.sortBy;
      } else {
        if (chip.classList.contains('active')) {
          chip.classList.remove('active');
          state.filters[filterType] = 'ALL';
        } else {
          document.querySelectorAll(`.tag-chip[data-filter-type="${filterType}"]`).forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          state.filters[filterType] = filterVal;
        }
      }

      applyFilters();
      renderActiveView();
      updateKpis();
    });
  });

  // Onglets de vue
  document.querySelectorAll('.view-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.getAttribute('data-view');
      switchView(view);
    });
  });

  // Redimensionnement automatique de la carte
  window.addEventListener('resize', () => {
    if (state.mapInstance && state.activeView === 'map') {
      state.mapInstance.invalidateSize();
    }
  });

  // Fermeture du Drawer au clic sur le fond
  const drawerBackdrop = document.getElementById('drawer-backdrop');
  if (drawerBackdrop) {
    drawerBackdrop.addEventListener('click', (e) => {
      if (e.target === drawerBackdrop) closeDrawer();
    });
  }
}

/**
 * Listes déroulantes Région / Département (générées depuis FRANCE_GEO, avec le nombre de librairies)
 */
function populateRegionSelect() {
  const select = document.getElementById('filter-region');
  if (!select || typeof FRANCE_GEO === 'undefined') return;

  const counts = {};
  state.bookstores.forEach(b => { counts[b.region_code] = (counts[b.region_code] || 0) + 1; });

  select.innerHTML = `<option value="ALL">🇫🇷 Toutes les régions (${state.bookstores.length})</option>` +
    FRANCE_GEO.regions
      .filter(r => counts[r.code])
      .map(r => `<option value="${r.code}">${escapeHtml(r.nom)} (${counts[r.code]})</option>`)
      .join('');
  select.value = state.filters.region;
}

function populateDepartmentSelect() {
  const select = document.getElementById('filter-department');
  if (!select || typeof FRANCE_GEO === 'undefined') return;

  const region = state.filters.region;
  const counts = {};
  state.bookstores
    .filter(b => region === 'ALL' || b.region_code === region)
    .forEach(b => { counts[b.departement_code] = (counts[b.departement_code] || 0) + 1; });

  select.innerHTML = '<option value="ALL">📍 Tous les départements</option>' +
    FRANCE_GEO.departements
      .filter(d => counts[d.code])
      .map(d => `<option value="${d.code}">${d.code} - ${escapeHtml(d.nom)} (${counts[d.code]})</option>`)
      .join('');
  select.value = state.filters.department;
}

/**
 * Librairies du périmètre géographique choisi (région + département), avant les autres filtres.
 * Sert aux KPIs et aux analyses.
 */
function getScopeBookstores() {
  const f = state.filters;
  return state.bookstores.filter(b =>
    (f.region === 'ALL' || b.region_code === f.region) &&
    (f.department === 'ALL' || b.departement_code === f.department)
  );
}

function getScopeLabel() {
  const f = state.filters;
  const geo = typeof FRANCE_GEO !== 'undefined' ? FRANCE_GEO : { regions: [], departements: [] };
  if (f.department !== 'ALL') {
    const d = geo.departements.find(x => x.code === f.department);
    return d ? `${d.nom} (${d.code})` : f.department;
  }
  if (f.region !== 'ALL') {
    const r = geo.regions.find(x => x.code === f.region);
    const nbDepts = new Set(getScopeBookstores().map(b => b.departement_code)).size;
    return `${r ? r.nom : f.region} (${nbDepts} départements)`;
  }
  return 'France entière';
}

/**
 * Librairie exclusivement Jeunesse et/ou BD-Manga : TOUTES ses catégories officielles sont
 * dans cette liste. Elle est alors exclue de la cible principale ; une librairie qui a aussi
 * une autre catégorie (Généraliste, Autres, Religion...) reste dans la cible.
 */
const JBM_CATEGORIES = ['Jeunesse', 'BD et Mangas'];
function isExclusivelyJBM(item) {
  const cats = item.categories && item.categories.length ? item.categories : [item.assortiment];
  return cats.every(c => JBM_CATEGORIES.includes(c));
}

/**
 * 4. Application des Filtres & Tri
 */
function applyFilters() {
  const f = state.filters;
  const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/Ã©|Ã¨|Ã|©/g, 'e');

  let list = state.bookstores.filter(item => {
    // Filtre texte (nom, commune, cp, spécialité, notes, email, tel, siret)
    if (f.search) {
      const searchNorm = norm(f.search);
      const matchText = norm(
        (item.nom || '') + ' ' +
        (item.commune || '') + ' ' +
        (item.code_postal || '') + ' ' +
        (item.assortiment || '') + ' ' +
        (item.adresse || '') + ' ' +
        (item.email || '') + ' ' +
        (item.telephone || '') + ' ' +
        (item.siret || '') + ' ' +
        (item.notes_prospection || '')
      );
      if (!matchText.includes(searchNorm)) return false;
    }

    // Filtre région
    if (f.region !== 'ALL' && item.region_code !== f.region) {
      return false;
    }

    // Filtre département
    if (f.department !== 'ALL' && item.departement_code !== f.department) {
      return false;
    }

    // Filtre exclusion 100% Jeunesse / BD / Manga (Cible principale)
    if (f.excludeJBM && isExclusivelyJBM(item)) {
      return false;
    }

    // Filtre spécialité / catégories multi-critères
    if (f.specialty === 'EXCLUDE_JBM') {
      if (isExclusivelyJBM(item)) return false;
    } else if (f.specialty !== 'ALL') {
      // Correspondance exacte (sinon « VO » attraperait « Voyage »)
      if (!(item.categories || [item.assortiment]).includes(f.specialty)) return false;
    }

    // Filtre Favoris uniquement
    if (f.onlyFavorites && !item.is_favorite) {
      return false;
    }

    // Filtre Label LIR
    if (f.labelLir === 'LIR' && !item.is_lir) return false;
    if (f.labelLir === 'NON_LIR' && item.is_lir) return false;

    // Filtre Statut commercial
    if (f.status !== 'ALL' && item.statut_prospection !== f.status) {
      return false;
    }

    // Filtre « joignable » : téléphone ou email connu
    if (f.joignable === 'OUI' && !item.telephone && !item.email) return false;

    // Filtre Priorité
    if (f.priority !== 'ALL' && item.priorite !== f.priority) {
      return false;
    }

    return true;
  });

  // Tri
  // Les valeurs non récupérées (null) passent en fin de liste
  const desc = key => (a, b) => (b[key] ?? -1) - (a[key] ?? -1);
  if (f.sortBy === 'ressemblance_desc') {
    // Clients et fiches sans note en fin de liste
    const sc = new Map(list.map(b => [b.id, (ressemblance(b) || { score: -1 }).score]));
    list.sort((a, b) => sc.get(b.id) - sc.get(a.id));
  } else if (f.sortBy === 'rating_desc') {
    list.sort(desc('google_rating'));
  } else if (f.sortBy === 'reviews_desc') {
    list.sort(desc('google_reviews_count'));
  } else if (f.sortBy === 'name_asc') {
    list.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  } else if (f.sortBy === 'city_asc') {
    list.sort((a, b) => a.commune.localeCompare(b.commune, 'fr'));
  }

  state.filteredBookstores = list;

  const countBadge = document.getElementById('results-count-badge');
  if (countBadge) {
    countBadge.textContent = `${list.length} sur ${state.bookstores.length} librairies`;
  }
  saveUiState();
}

/**
 * 5. Changement de Vue
 */
function switchView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active-view'));
  const targetSec = document.getElementById(`view-${viewName}`);
  if (targetSec) targetSec.classList.add('active-view');
  document.querySelectorAll('.view-tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === viewName));
  document.body.dataset.vue = ['accueil', 'clients'].includes(viewName) ? 'gestion' : 'prospection';
  renderActiveView();
  saveUiState();
}

function renderActiveView() {
  switch (state.activeView) {
    case 'map':
      renderMapView();
      break;
    case 'table':
      renderTableView();
      break;
    case 'cards':
      renderCardsView();
      break;
    case 'kanban':
      renderKanbanView();
      break;
    case 'analytics':
      renderAnalyticsView();
      break;
    case 'france':
      renderFranceView();
      break;
    case 'accueil':
      renderAccueilView();
      break;
    case 'clients':
      renderClientsView();
      break;
  }
}

function goView(viewName) {
  switchView(viewName);
}

// Accueil › « Voir tous les prospects classés » : tableau de toute la France trié par ressemblance
function voirTousProspects() {
  state.filters.region = 'ALL';
  state.filters.department = 'ALL';
  state.filters.status = 'A_CONTACTER';
  state.filters.sortBy = 'ressemblance_desc';
  syncControlsFromState();
  state.needsFitBounds = true;
  applyFilters();
  switchView('table');
  updateKpis();
  window.scrollTo(0, 0);
}

/**
 * Défilement : en-tête, onglets et filtres restent collés en haut ; les chiffres clés défilent hors de vue.
 * La barre des onglets se place juste sous l'en-tête, dont la hauteur varie selon la largeur de l'écran.
 */
function initStickyBars() {
  const header = document.getElementById('main-header');
  const kpis = document.getElementById('kpi-summary-strip');
  const controls = document.getElementById('controls-section');
  // Hauteurs de l'en-tête et de la barre onglets + filtres : les titres de colonnes des tableaux se collent dessous
  const setHeaderHeight = () => {
    document.documentElement.style.setProperty('--header-h', (header ? header.offsetHeight : 0) + 'px');
    document.documentElement.style.setProperty('--controls-h', (controls ? controls.offsetHeight : 0) + 'px');
  };
  setHeaderHeight();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(setHeaderHeight);
    if (header) ro.observe(header);
    if (controls) ro.observe(controls);
  }
  window.addEventListener('resize', setHeaderHeight);
  const onScroll = () => {
    const limit = kpis ? kpis.offsetTop + kpis.offsetHeight - (header ? header.offsetHeight : 0) : 80;
    document.body.classList.toggle('scrolled', window.scrollY > limit);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// Fiche client reliée à une librairie (cache d'une seconde : appelé pour chaque ligne affichée)
function estClient(librairieId) {
  const now = Date.now();
  if (!state._clients || now - state._clientsAt > 1000) {
    state._clients = new Map(Object.values(Suivi.collection('pdv')).filter(p => p.librairie_id && !p.supprime).map(p => [p.librairie_id, p]));
    state._clientsAt = now;
  }
  return state._clients.get(librairieId) || null;
}

/**
 * 6. Mise à jour des KPIs Globaux
 */
function updateKpis() {
  const scope = getScopeBookstores();
  const scopeLabel = getScopeLabel();
  const pilotBadge = document.getElementById('pilot-badge');
  if (pilotBadge) pilotBadge.textContent = `${scopeLabel.split(' (')[0]} (${scope.length})`;
  const favBadge = document.getElementById('fav-count-badge');
  if (favBadge) favBadge.textContent = state.bookstores.filter(b => b.is_favorite).length;
  updateKpisGestion();
}

/**
 * 7. VUE CARTE (LEAFLET OPENSTREETMAP)
 */
function renderMapView() {
  const mapContainer = document.getElementById('leaflet-map');
  if (!mapContainer) return;

  if (!state.mapInstance) {
    if (typeof L === 'undefined') {
      mapContainer.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);flex-direction:column;gap:0.75rem;">
          <p>Carte indisponible : la bibliothèque Leaflet n'a pas pu être chargée (connexion Internet requise).</p>
        </div>
      `;
      return;
    }

    state.mapInstance = L.map('leaflet-map', {
      zoomControl: true,
      minZoom: 3,
      maxZoom: 18
    });
    // Position mémorisée (rafraîchissement) ; sinon cadrage sur la zone choisie
    if (state.mapView) {
      state.mapInstance.setView([state.mapView.lat, state.mapView.lng], state.mapView.zoom);
      state.needsFitBounds = false;
    } else {
      state.mapInstance.setView([48.11, -2.9], 8);
      state.needsFitBounds = true;
    }
    state.mapInstance.on('moveend', () => {
      const c = state.mapInstance.getCenter();
      state.mapView = { lat: c.lat, lng: c.lng, zoom: state.mapInstance.getZoom() };
      saveUiState();
    });

    // Fonds de carte libres, sans clé
    const osmStandardLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributeurs',
      maxZoom: 19
    });
    const osmFrLayer = L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap France | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    });
    const esriLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19
    });
    osmFrLayer.addTo(state.mapInstance);
    L.control.layers({
      "🗺️ OpenStreetMap France (Recommandé)": osmFrLayer,
      "🌍 OpenStreetMap International": osmStandardLayer,
      "🛰️ Plan Esri": esriLayer
    }, null, { position: 'topright' }).addTo(state.mapInstance);

    // Regroupement des marqueurs : indispensable avec ~3 200 librairies, et pour séparer
    // les librairies d'une même commune localisées au même point (centre de la commune)
    state.markersLayer = (typeof L.markerClusterGroup === 'function'
      ? L.markerClusterGroup({ maxClusterRadius: 45, spiderfyOnMaxZoom: true, chunkedLoading: true })
      : L.layerGroup()
    ).addTo(state.mapInstance);
  }

  state.markersLayer.clearLayers();
  const newMarkers = [];

  state.filteredBookstores.forEach(item => {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return;

    let markerColor = '#6b7280';
    if (item.statut_prospection === 'CLIENT_ACTIF') markerColor = '#10b981';
    else if (item.statut_prospection === 'RDV_PRIS') markerColor = '#f59e0b';
    else if (item.statut_prospection === 'CATALOGUE_ENVOYE') markerColor = '#8b5cf6';
    else if (item.statut_prospection === 'CONTACTE') markerColor = '#0284c7';
    else if (item.statut_prospection === 'A_RELANCER') markerColor = '#f43f5e';

    // Position approximative (centre de commune) : épingle en pointillés
    const approx = item.localisation !== 'adresse';
    const customIcon = L.divIcon({
      className: 'custom-map-pin',
      html: `
        <div style="background:${markerColor};width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
          border:2px ${approx ? 'dashed' : 'solid'} #ffffff;box-shadow:0 4px 10px rgba(0,0,0,0.5);opacity:${approx ? 0.75 : 1};
          display:flex;align-items:center;justify-content:center;cursor:pointer;">
          <span style="transform:rotate(45deg);font-size:13px;color:#fff;">📚</span>
        </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -28]
    });

    const popupHtml = `
      <div class="popup-inner">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
          <span style="font-size:0.7rem;font-weight:700;color:${markerColor};text-transform:uppercase;">${formatStatusName(item.statut_prospection)}</span>
          <div style="display:flex;align-items:center;gap:0.35rem;">
            <button class="btn-fav-inline ${item.is_favorite ? 'active' : ''}" onclick="toggleFavorite(${item.id}, event)" title="${item.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
              ${item.is_favorite ? '⭐' : '☆'}
            </button>
            ${item.is_lir ? '<span class="badge-lir">★ LIR</span>' : ''}${estClient(item.id) ? '<span class="badge-client">🤝 Client</span>' : ''}${ressemblanceBadge(item)}
          </div>
        </div>
        <h4 class="popup-title" style="margin-top:0.3rem;">${escapeHtml(item.nom)}</h4>
        <div class="popup-meta">
          📍 ${addressHtml(item)}<br>
          📖 ${escapeHtml(item.assortiment)}<br>
          ⭐ ${ratingHtml(item)}<br>
          🏛️ SIRET : ${siretHtml(item)}
        </div>
        <div style="font-size:0.75rem;margin-bottom:0.4rem;display:flex;flex-direction:column;gap:0.25rem;">
          <div>📞 ${phoneHtml(item)}</div>
          <div>✉️ ${emailHtml(item)}</div>
        </div>
        <div class="popup-actions">
          <button class="btn btn-primary btn-sm" onclick="openDrawer(${item.id})" style="padding:0.3rem 0.6rem;font-size:0.75rem;">
            📝 Fiche Prospection
          </button>
          <a href="${escapeHtml(item.google_maps_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="padding:0.3rem 0.6rem;font-size:0.75rem;">
            🗺️ Google Maps
          </a>
        </div>
      </div>
    `;

    newMarkers.push(L.marker([item.latitude, item.longitude], { icon: customIcon }).bindPopup(popupHtml));
  });

  if (typeof state.markersLayer.addLayers === 'function') state.markersLayer.addLayers(newMarkers);
  else newMarkers.forEach(m => state.markersLayer.addLayer(m));

  // Recadrage sur la zone choisie (région / département)
  if (state.needsFitBounds && newMarkers.length) {
    state.needsFitBounds = false;
    // Sur "Toutes les régions", on cadre la métropole (l'outre-mer reste visible en dézoomant)
    let points = newMarkers.map(m => m.getLatLng());
    const metro = points.filter(p => p.lat > 41 && p.lat < 52 && p.lng > -6 && p.lng < 10);
    if (state.filters.region === 'ALL' && metro.length) points = metro;
    const bounds = L.latLngBounds(points);
    setTimeout(() => {
      if (state.mapInstance) state.mapInstance.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
    }, 250);
  }

  setTimeout(() => {
    if (state.mapInstance) state.mapInstance.invalidateSize();
  }, 200);
}

/**
 * 8. VUE TABLEAU CRM
 */
function renderTableView() {
  const tableBody = document.getElementById('crm-table-body');
  if (!tableBody) return;

  if (state.filteredBookstores.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center;padding:3rem;color:var(--text-muted);">
          Aucune librairie ne correspond à vos critères de recherche.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = state.filteredBookstores.map(item => `
    <tr>
      <td>
        <div class="cell-name-box">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <button class="btn-fav-inline ${item.is_favorite ? 'active' : ''}" onclick="toggleFavorite(${item.id}, event)" title="${item.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
              ${item.is_favorite ? '⭐' : '☆'}
            </button>
            <span class="cell-name" onclick="openDrawer(${item.id})">${escapeHtml(item.nom)}</span>
          </div>
          <div style="display:flex;gap:0.35rem;align-items:center;flex-wrap:wrap;margin-left:1.4rem;margin-top:0.2rem;">
            ${item.is_lir ? '<span class="badge-lir">★ LIR</span>' : ''}${estClient(item.id) ? '<span class="badge-client">🤝 Client</span>' : ''}${ressemblanceBadge(item)}
            ${(item.categories || [item.assortiment]).map(cat => `
              <span class="badge-specialty-mini">${escapeHtml(cat)}</span>
            `).join('')}
          </div>
        </div>
      </td>
      <td>
        <strong>${escapeHtml(item.commune)}</strong>
        <div style="font-size:0.7rem;color:var(--text-muted);">${escapeHtml(item.code_postal)} (${escapeHtml(item.departement_nom)})</div>
      </td>
      <td>${ratingHtml(item, true)}</td>
      <td>
        <div>📞 ${phoneHtml(item)}</div>
        <div style="font-size:0.75rem;margin-top:0.2rem;">✉️ ${emailHtml(item)}</div>
      </td>
      <td>
        <select class="status-select-inline" onchange="updateBookstoreStatus(${item.id}, this.value)" style="border-color:${getStatusColor(item.statut_prospection)};color:${getStatusColor(item.statut_prospection)};">
          ${STATUS_OPTIONS.map(s => `<option value="${s.key}" ${item.statut_prospection === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </td>
      <td>
        <span style="font-size:0.75rem;font-weight:700;color:${item.priorite === 'HAUTE' ? 'var(--accent-rose)' : 'var(--text-secondary)'};">
          ${escapeHtml(item.priorite)}
        </span>
      </td>
      <td>
        <div style="display:flex;gap:0.35rem;">
          <a href="${escapeHtml(item.google_maps_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-icon" title="Ouvrir dans Google Maps">🗺️</a>
          <button class="btn btn-primary" onclick="openDrawer(${item.id})" style="padding:0.3rem 0.65rem;">Fiche</button>
        </div>
      </td>
    </tr>
  `).join('');
}

/**
 * 9. VUE GRILLE DE FICHES (CARDS)
 */
function renderCardsView() {
  const cardsContainer = document.getElementById('bookstores-cards-container');
  if (!cardsContainer) return;

  if (state.filteredBookstores.length === 0) {
    cardsContainer.innerHTML = `
      <div style="grid-column: 1/-1; text-align:center; padding: 4rem; color: var(--text-muted);">
        Aucune librairie ne correspond à vos filtres.
      </div>
    `;
    return;
  }

  cardsContainer.innerHTML = state.filteredBookstores.map(item => `
    <div class="bookstore-card">
      <div>
        <div class="card-top">
          <div style="flex:1;min-width:0;">
            <h3 class="card-title" onclick="openDrawer(${item.id})">${escapeHtml(item.nom)}</h3>
            <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.15rem;">
              📍 ${escapeHtml(item.commune)} (${escapeHtml(item.code_postal)})
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:0.35rem;">
            <button class="btn-fav ${item.is_favorite ? 'active' : ''}" onclick="toggleFavorite(${item.id}, event)" title="${item.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
              ${item.is_favorite ? '⭐' : '☆'}
            </button>
            ${item.is_lir ? '<span class="badge-lir">★ LIR</span>' : ''}${estClient(item.id) ? '<span class="badge-client">🤝 Client</span>' : ''}${ressemblanceBadge(item)}
          </div>
        </div>

        <div class="card-rating-strip">⭐ ${ratingHtml(item)}</div>

        <div class="card-details">
          <div class="card-detail-item">
            <span class="card-detail-icon">🏢</span>
            <span>${addressHtml(item)}</span>
          </div>
          <div class="card-detail-item" style="font-size:0.725rem;">
            <span class="card-detail-icon">🏛️</span>
            <span>SIRET : ${siretHtml(item)}</span>
          </div>
          <div class="card-detail-item card-contacts-row">
            <span class="contact-pill"><span class="card-detail-icon">📞</span>${phoneHtml(item)}</span>
            <span class="contact-pill email-pill"><span class="card-detail-icon">✉️</span>${emailHtml(item)}</span>
          </div>
          <div class="card-detail-item">
            <span class="card-detail-icon">🕒</span>
            <span style="font-size:0.75rem;">${fieldHtml(item, 'horaires')}</span>
          </div>
        </div>

        <div class="card-tags">
          ${(item.categories || [item.assortiment]).map(cat => `
            <span class="badge-specialty">📖 ${escapeHtml(cat)}</span>
          `).join('')}
          <span class="badge-specialty" style="color:${getStatusColor(item.statut_prospection)};border-color:${getStatusColor(item.statut_prospection)};">
            ● ${formatStatusName(item.statut_prospection)}
          </span>
        </div>
      </div>

      <div class="card-actions">
        ${safeTel(item.telephone) ? `
          <a href="tel:${safeTel(item.telephone)}" class="btn btn-secondary" title="Appeler">📞 Appel</a>
        ` : `
          <button class="btn btn-secondary" onclick="openDrawer(${item.id})" title="Rechercher ou saisir les coordonnées">📞 Coordonnées</button>
        `}
        <a href="${escapeHtml(item.google_maps_url)}" target="_blank" rel="noopener" class="btn btn-secondary" title="Voir sur Google Maps">🗺️ Maps</a>
        <button class="btn btn-primary" onclick="openDrawer(${item.id})">Ouvrir la fiche</button>
      </div>
    </div>
  `).join('');
}

/**
 * 10. VUE PIPELINE KANBAN
 */
function renderKanbanView() {
  const kanbanBoard = document.getElementById('kanban-board');
  if (!kanbanBoard) return;

  kanbanBoard.innerHTML = STATUS_OPTIONS.map(col => {
    const colItems = state.filteredBookstores.filter(b => b.statut_prospection === col.key);
    // Au-delà de 200 fiches par colonne, l'affichage devient illisible et lent : on tronque
    const shown = colItems.slice(0, 200);

    return `
      <div class="kanban-column" style="border-top: 3px solid ${getStatusColor(col.key)};">
        <div class="kanban-col-header">
          <span>${col.icon} ${col.label}</span>
          <span class="kanban-col-count">${colItems.length}</span>
        </div>
        <div class="kanban-cards-list">
          ${shown.map(item => `
            <div class="kanban-item" onclick="openDrawer(${item.id})">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.35rem;">
                <span style="font-weight:700;font-size:0.85rem;color:var(--text-primary);">${escapeHtml(item.nom)}</span>
                <div style="display:flex;align-items:center;gap:0.25rem;">
                  <button class="btn-fav-inline ${item.is_favorite ? 'active' : ''}" onclick="toggleFavorite(${item.id}, event)" title="${item.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
                    ${item.is_favorite ? '⭐' : '☆'}
                  </button>
                  ${item.is_lir ? '<span class="badge-lir" style="font-size:0.6rem;">LIR</span>' : ''}
                </div>
              </div>
              <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.4rem;">
                📍 ${escapeHtml(item.commune)} (${escapeHtml(item.departement_code)})
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.7rem;color:var(--text-muted);border-top:1px solid var(--border-subtle);padding-top:0.35rem;">
                <span>${item.google_rating != null ? `⭐ ${item.google_rating}` : ''}</span>
                <span style="color:var(--text-gold);">${item.priorite === 'HAUTE' ? '🔥 Haute' : ''}</span>
              </div>
            </div>
          `).join('')}
          ${colItems.length > shown.length ? `<div style="text-align:center;padding:0.75rem 0;color:var(--text-muted);font-size:0.75rem;">… et ${colItems.length - shown.length} autres : affinez les filtres</div>` : ''}
          ${colItems.length === 0 ? '<div style="text-align:center;padding:2rem 0;color:var(--text-muted);font-size:0.75rem;">Aucune librairie</div>' : ''}
        </div>
      </div>
    `;
  }).join('');
}

/**
 * 11. VUE ANALYTICS & KPIS DÉTAILLÉS
 */
function renderAnalyticsView() {
  const container = document.getElementById('analytics-content-container');
  if (!container) return;

  const scope = getScopeBookstores();
  const total = scope.length || 1;

  // Répartition géographique : par région si "Toutes les régions", sinon par département
  const byRegion = state.filters.region === 'ALL';
  const palette = ['#38bdf8', '#0284c7', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6', '#eab308'];
  const geoCounts = {};
  scope.forEach(b => {
    const key = byRegion ? b.region : `${b.departement_nom} (${b.departement_code})`;
    geoCounts[key] = (geoCounts[key] || 0) + 1;
  });
  const depts = Object.entries(geoCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([nom, count], i) => ({ nom, count, color: palette[i % palette.length] }));
  const geoTitle = byRegion ? 'Répartition par Région' : `Répartition par Département (${getScopeLabel().replace(/ \(\d+ départements\)$/, '')})`;

  // Calcul répartition spécialités
  const specialtyCounts = {};
  scope.forEach(b => {
    specialtyCounts[b.assortiment] = (specialtyCounts[b.assortiment] || 0) + 1;
  });
  const sortedSpecialties = Object.entries(specialtyCounts).sort((a, b) => b[1] - a[1]);

  // Statuts de prospection
  const statusCounts = {};
  scope.forEach(b => {
    statusCounts[b.statut_prospection] = (statusCounts[b.statut_prospection] || 0) + 1;
  });

  container.innerHTML = `
    <div class="analytics-grid">
      <!-- Répartition par département -->
      <div class="chart-card">
        <h3>📍 ${escapeHtml(geoTitle)}</h3>
        ${depts.map(d => `
          <div class="bar-progress-row">
            <span class="bar-label" title="${escapeHtml(d.nom)}">${escapeHtml(d.nom)}</span>
            <div class="bar-track">
              <div class="bar-fill" style="width: ${(d.count / total) * 100}%; background: ${d.color};"></div>
            </div>
            <span class="bar-val">${d.count} (${Math.round((d.count / total) * 100)}%)</span>
          </div>
        `).join('')}
      </div>

      <!-- Répartition par Spécialité -->
      <div class="chart-card">
        <h3>📖 Typologie & Lignes Éditoriales</h3>
        ${sortedSpecialties.slice(0, 6).map(([spec, cnt], i) => `
          <div class="bar-progress-row">
            <span class="bar-label" title="${spec}">${spec}</span>
            <div class="bar-track">
              <div class="bar-fill" style="width: ${(cnt / total) * 100}%; background: var(--accent-indigo);"></div>
            </div>
            <span class="bar-val">${cnt}</span>
          </div>
        `).join('')}
      </div>

      <!-- Pipeline de Prospection -->
      <div class="chart-card">
        <h3>🎯 État d'avancement de la Prospection</h3>
        ${[
          { key: 'A_CONTACTER', label: 'À Contacter', color: 'var(--status-a-contacter)' },
          { key: 'CONTACTE', label: 'Contacté', color: 'var(--status-contacte)' },
          { key: 'CATALOGUE_ENVOYE', label: 'Catalogue Envoyé', color: 'var(--status-catalogue)' },
          { key: 'RDV_PRIS', label: 'RDV Fixé', color: 'var(--status-rdv)' },
          { key: 'CLIENT_ACTIF', label: 'Client Actif (Compte ouvert)', color: 'var(--status-client)' },
          { key: 'A_RELANCER', label: 'À Relancer', color: 'var(--status-relance)' }
        ].map(s => {
          const count = statusCounts[s.key] || 0;
          return `
            <div class="bar-progress-row">
              <span class="bar-label">${s.label}</span>
              <div class="bar-track">
                <div class="bar-fill" style="width: ${(count / total) * 100}%; background: ${s.color};"></div>
              </div>
              <span class="bar-val">${count}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

/**
 * 12. VUE SOMMAIRE NATIONAL (FRANCE ENTIÈRE)
 */
function renderFranceView() {
  const container = document.getElementById('france-content-container');
  if (!container) return;

  // Calculé à partir des données chargées (une seule source : data/librairies.js + votre suivi)
  const all = state.bookstores;
  const meta = typeof LIBRAIRIES_META !== 'undefined' ? LIBRAIRIES_META : { sources: {}, stats: {} };
  const count = fn => all.filter(fn).length;
  const pct = n => all.length ? Math.round((n / all.length) * 100) : 0;

  const byRegion = {};
  all.forEach(b => {
    const r = byRegion[b.region_code] || (byRegion[b.region_code] = { nom: b.region || '—', total: 0, lir: 0, siret: 0, tel: 0, email: 0, cible: 0 });
    r.total++;
    if (b.is_lir) r.lir++;
    if (b.siret) r.siret++;
    if (b.telephone) r.tel++;
    if (b.email) r.email++;
    if (!isExclusivelyJBM(b)) r.cible++;
  });
  const rows = Object.values(byRegion).sort((a, b) => b.total - a.total);

  const fields = [
    ['siret', 'SIRET'], ['adresse', 'Adresse'], ['position', 'Position exacte'], ['telephone', 'Téléphone'],
    ['email', 'Email'], ['site_web', 'Site web'], ['horaires', "Horaires d'ouverture"]
  ];
  const levels = ['saisie', 'verifie', 'probable', 'a_verifier'];
  const COLORS = { saisie: 'var(--lvl-saisie)', verifie: 'var(--lvl-verifie)', probable: 'var(--lvl-probable)', a_verifier: 'var(--lvl-averifier)' };
  const coverage = fields.map(([k, label]) => {
    const has = b => k === 'position' ? b.localisation === 'adresse' : !!b[k];
    const byLvl = Object.fromEntries(levels.map(l => [l, count(b => has(b) && b.info?.[k]?.niveau === l)]));
    return { label, byLvl, total: count(has) };
  });

  container.innerHTML = `
    <div class="france-overview-box">
      <h2>🇫🇷 Panorama, fiabilité et sources</h2>
      <p style="color:var(--text-secondary);font-size:0.875rem;margin-bottom:1.25rem;">
        ${all.length.toLocaleString('fr-FR')} librairies, issues de ${(meta.stats.lignes_officielles || all.length).toLocaleString('fr-FR')} lignes de la liste officielle
        (les lignes d'une même librairie — rayons, magasins, variantes d'orthographe, même SIRET — sont regroupées).
        Données mises à jour automatiquement chaque mois ; dernière mise à jour le ${escapeHtml(formatDateFr(meta.genere_le) || '—')}.
      </p>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem;">
        <div style="background:var(--bg-tertiary);padding:1rem;border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;">France (métropole + outre-mer)</div>
          <div style="font-size:1.8rem;font-weight:800;color:var(--text-primary);font-family:var(--font-heading);">${all.length.toLocaleString('fr-FR')}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);">librairies recensées</div>
        </div>
        <div style="background:var(--bg-tertiary);padding:1rem;border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;">Cible principale</div>
          <div style="font-size:1.8rem;font-weight:800;color:var(--accent-emerald);font-family:var(--font-heading);">${count(b => !isExclusivelyJBM(b)).toLocaleString('fr-FR')}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);">hors librairies 100 % BD / Manga / Jeunesse</div>
        </div>
        <div style="background:var(--bg-tertiary);padding:1rem;border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
          <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;">Joignables</div>
          <div style="font-size:1.8rem;font-weight:800;color:var(--text-cyan);font-family:var(--font-heading);">${count(b => b.telephone || b.email).toLocaleString('fr-FR')}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);">avec un téléphone ou un email</div>
        </div>
      </div>

      <h3 style="font-size:1rem;font-weight:700;margin-bottom:0.5rem;">Niveaux de fiabilité</h3>
      <div style="display:flex;flex-direction:column;gap:0.35rem;margin-bottom:1rem;font-size:0.8rem;">
        ${['officiel', ...levels].map(l => `<div>${niveauBadge({ niveau: l, source: '' }, true)} <span style="color:var(--text-secondary);">${NIVEAUX[l].aide}</span></div>`).join('')}
        <div><span class="data-missing">À récupérer</span> <span style="color:var(--text-secondary);">Information pas encore trouvée</span></div>
      </div>

      <h3 style="font-size:1rem;font-weight:700;margin-bottom:0.75rem;">Informations disponibles, par niveau de fiabilité</h3>
      <div style="margin-bottom:1.5rem;">
        ${coverage.map(c => `
          <div class="bar-progress-row">
            <span class="bar-label">${c.label}</span>
            <div class="bar-track" style="display:flex;">
              ${levels.map(l => `<div class="bar-fill" title="${NIVEAUX[l].label} : ${c.byLvl[l]}" style="width:${pct(c.byLvl[l])}%;background:${COLORS[l]};border-radius:0;"></div>`).join('')}
            </div>
            <span class="bar-val">${c.total.toLocaleString('fr-FR')} (${pct(c.total)} %)</span>
          </div>
        `).join('')}
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.5rem;">
          Couleurs : vert = vérifié, jaune = probable, orange = à vérifier, violet = saisi par vous. Le reste est « à récupérer » :
          utilisez « Chercher dans SIRENE » et les liens de recherche de chaque fiche.
        </p>
      </div>

      <h3 style="font-size:1rem;font-weight:700;margin-bottom:0.75rem;">Répartition par région</h3>
      <div style="overflow-x:auto;">
        <table class="regions-table">
          <thead>
            <tr>
              <th>Région</th>
              <th style="text-align:right;">Librairies</th>
              <th style="text-align:right;">Cible principale</th>
              <th style="text-align:right;">Label LIR</th>
              <th style="text-align:right;">SIRET</th>
              <th style="text-align:right;">Téléphone</th>
              <th style="text-align:right;">Email</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${escapeHtml(r.nom)}</td>
                <td style="text-align:right;">${r.total}</td>
                <td style="text-align:right;">${r.cible}</td>
                <td style="text-align:right;color:var(--text-gold);">${r.lir}</td>
                <td style="text-align:right;">${Math.round(r.siret / r.total * 100)} %</td>
                <td style="text-align:right;">${Math.round(r.tel / r.total * 100)} %</td>
                <td style="text-align:right;">${Math.round(r.email / r.total * 100)} %</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <h3 style="font-size:1rem;font-weight:700;margin:1.5rem 0 0.5rem;">Sources</h3>
      <ul style="font-size:0.8rem;color:var(--text-secondary);padding-left:1.2rem;line-height:1.7;">
        <li>Liste des librairies : ${escapeHtml(meta.sources.liste || '—')}</li>
        <li>SIRET, adresse, position : ${escapeHtml(meta.sources.sirene || '—')}</li>
        <li>Téléphone, email, site, horaires : ${escapeHtml(meta.sources.osm || '—')}</li>
        <li>Vérifications : ${escapeHtml(meta.sources.web || '—')}</li>
        <li>Notes Google : ${escapeHtml(meta.sources.google || '—')}</li>
      </ul>
    </div>
  `;
}

/**
 * 13. OUVERTURE & GESTION DU DRAWER (FICHE DÉTAILLÉE GOOGLE MAPS & CRM)
 */
function openDrawer(id) {
  const item = state.bookstores.find(b => b.id === id);
  if (!item) return;

  state.selectedBookstore = item;
  state.selectedClient = null;

  const backdrop = document.getElementById('drawer-backdrop');
  const drawerContainer = document.getElementById('drawer-content-body');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerSub = document.getElementById('drawer-sub');

  if (drawerTitle) drawerTitle.textContent = item.nom;
  if (drawerSub) {
    drawerSub.innerHTML = `
      📍 ${escapeHtml(item.commune)} (${escapeHtml(item.code_postal)}) &nbsp;•&nbsp;
      <span style="color:var(--accent-cyan-light);">${escapeHtml(item.assortiment)}</span>
      ${item.is_lir ? ' &nbsp;•&nbsp; <span class="badge-lir">★ LIR</span>' : ''}
      <button class="btn btn-secondary btn-sm ${item.is_favorite ? 'active' : ''}" id="drawer-fav-btn" onclick="toggleFavorite(${item.id}, event)" style="margin-left:0.75rem;padding:0.2rem 0.55rem;font-size:0.75rem;">
        ${item.is_favorite ? '⭐ En favori' : '☆ Mettre en favori'}
      </button>
    `;
  }

  const q = encodeURIComponent(`${item.nom} librairie ${item.commune}`);
  const piste = item.sirene_piste;

  const client = estClient(item.id);
  const situation = client ? (calculGestion().parPdv.get(client.id) || null) : null;

  if (drawerContainer) {
    drawerContainer.innerHTML = `
      ${client ? `
      <div class="drawer-section g-client-box">
        <h3>🤝 Client</h3>
        <p>${situation ? `${situation.stockTotal} ex. en dépôt (${euros(situation.valeurStock)} HT)${situation.aFacturer ? ` · <strong>${euros(situation.aFacturer)} à facturer</strong>` : ''}${situation.impayes ? ` · <span class="data-check">${euros(situation.impayes)} impayés</span>` : ''}${situation.dernierContact ? ` · dernier contact le ${formatDateFr(situation.dernierContact)}` : ''}` : 'Aucun mouvement enregistré.'}</p>
        <button class="btn btn-primary btn-sm" onclick="openClient('${escapeHtml(client.id)}')">Ouvrir le suivi client (dépôts, ventes, factures)</button>
      </div>` : ''}
      ${(() => {
        const r = ressemblance(item);
        return r ? `<div class="drawer-section">
          <h3>🎯 Ressemblance avec vos meilleurs clients : ${r.score}/100 <button class="g-info" onclick="openRessemblanceInfo()" title="Comment est-ce calculé ?">ⓘ</button></h3>
          <table class="g-table">${r.details.map(d => `<tr title="${escapeHtml(d.critere.explication)}"><td>${escapeHtml(d.critere.label)}</td><td style="text-align:right;white-space:nowrap;">${d.points}/${d.critere.poids}</td><td class="g-muted">${escapeHtml(d.detail)}</td></tr>`).join('')}</table>
        </div>` : '';
      })()}
      <div class="drawer-section">
        <h3>📍 Fiche établissement</h3>
        <p style="font-size:0.72rem;color:var(--text-muted);margin:-0.25rem 0 0.6rem;">
          Chaque information indique sa fiabilité (survolez le badge pour la source et la date) :
          ✅ vérifié · 🟡 probable (à confirmer au premier contact) · ⚠️ à vérifier · ✍️ saisi par vous · « À récupérer » : pas encore trouvée.
        </p>

        <div class="gmaps-card-box">
          <div class="info-item">
            <span class="info-label">Adresse :</span>
            <span class="info-value">${item.adresse ? escapeHtml(item.adresse) + infoDetail(item, 'adresse') : addressHtml(item)}</span>
          </div>
          ${item.adresse ? `
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-secondary" onclick="copyAddress(${item.id})" style="font-size:0.7rem;padding:0.2rem 0.5rem;">📋 Copier l'adresse</button>
          </div>` : ''}

          <div class="info-item">
            <span class="info-label">Position sur la carte :</span>
            <span class="info-value" style="font-size:0.75rem;">
              ${item.localisation === 'adresse' ? 'Adresse exacte' : 'Approximative (centre de la commune)'}
              ${infoDetail(item, 'position')}
            </span>
          </div>

          <div class="info-item">
            <span class="info-label">SIRET :</span>
            <span class="info-value">${item.siret ? `<span style="font-family:var(--font-mono);">${escapeHtml(item.siret)}</span>${infoDetail(item, 'siret')}` : siretHtml(item)}</span>
          </div>
          ${item.nom_officiel ? `
          <div class="info-item">
            <span class="info-label">Raison sociale :</span>
            <span class="info-value">${escapeHtml(item.nom_officiel)}</span>
          </div>` : ''}
          <div class="info-item">
            <span class="info-label">Activité (code NAF) :</span>
            <span class="info-value">${item.naf ? `${escapeHtml(item.naf)} ${NAF_LABELS[item.naf] ? '— ' + NAF_LABELS[item.naf] : ''}` : '<span class="data-missing">À récupérer</span>'}</span>
          </div>
          ${piste && !item.siret ? `
          <div class="info-item" style="flex-direction:column;align-items:flex-start;">
            <span class="info-label">Piste SIRENE non confirmée :</span>
            <span class="info-value data-check" style="font-size:0.75rem;">
              ${escapeHtml(piste.nom)} — SIRET ${escapeHtml(piste.siret)}<br>${escapeHtml(piste.adresse)} (NAF ${escapeHtml(piste.naf)})<br>
              <em>Motif du doute : ${escapeHtml(piste.motif)}</em>
            </span>
          </div>` : ''}
          <div style="display:flex;justify-content:flex-end;gap:0.4rem;flex-wrap:wrap;">
            <button class="btn btn-secondary" onclick="searchSireneLive(${item.id})" style="font-size:0.7rem;padding:0.2rem 0.5rem;">🔄 Chercher dans SIRENE</button>
            <a class="btn btn-secondary" href="https://annuaire-entreprises.data.gouv.fr/${item.siret ? 'etablissement/' + encodeURIComponent(item.siret) : 'rechercher?terme=' + q}" target="_blank" rel="noopener" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Annuaire des entreprises ↗</a>
          </div>
          <div id="sirene-live-results"></div>

          <div class="info-item">
            <span class="info-label">Avis Google :</span>
            <span class="info-value">${ratingHtml(item)}</span>
          </div>

          <div class="info-item">
            <span class="info-label">Téléphone :</span>
            <div style="display:flex;align-items:center;gap:0.5rem;flex:1;">
              <input type="tel" id="drawer-input-tel" class="crm-field-input" value="${escapeHtml(item.telephone || '')}" placeholder="À récupérer" style="font-size:0.8rem;padding:0.3rem 0.5rem;flex:1;">
              ${safeTel(item.telephone) ? `<a href="tel:${safeTel(item.telephone)}" class="btn btn-secondary btn-sm" style="padding:0.25rem 0.5rem;font-size:0.75rem;">📞 Appeler</a>` : ''}
            </div>
          </div>
          ${item.telephone ? `<div class="lvl-row">${infoDetail(item, 'telephone')}</div>` : ''}

          <div class="info-item">
            <span class="info-label">Email :</span>
            <div style="display:flex;align-items:center;gap:0.5rem;flex:1;">
              <input type="email" id="drawer-input-email" class="crm-field-input" value="${escapeHtml(item.email || '')}" placeholder="À récupérer" style="font-size:0.8rem;padding:0.3rem 0.5rem;flex:1;">
              ${safeEmail(item.email) ? `<a href="mailto:${safeEmail(item.email)}" class="btn btn-secondary btn-sm" style="padding:0.25rem 0.5rem;font-size:0.75rem;">✉️ Écrire</a>` : ''}
            </div>
          </div>
          ${item.email ? `<div class="lvl-row">${infoDetail(item, 'email')}</div>` : ''}

          <div class="info-item">
            <span class="info-label">Site web :</span>
            <div style="display:flex;align-items:center;gap:0.5rem;flex:1;">
              <input type="url" id="drawer-input-site" class="crm-field-input" value="${escapeHtml(item.site_web || '')}" placeholder="À récupérer" style="font-size:0.8rem;padding:0.3rem 0.5rem;flex:1;">
              ${safeUrl(item.site_web) ? `<a href="${escapeHtml(safeUrl(item.site_web))}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="padding:0.25rem 0.5rem;font-size:0.75rem;">Ouvrir ↗</a>` : ''}
            </div>
          </div>
          ${item.site_web ? `<div class="lvl-row">${infoDetail(item, 'site_web')}</div>` : ''}

          <div class="info-item">
            <span class="info-label">Horaires :</span>
            <input type="text" id="drawer-input-horaires" class="crm-field-input" value="${escapeHtml(item.horaires || '')}" placeholder="À récupérer" style="font-size:0.8rem;padding:0.3rem 0.5rem;flex:1;">
          </div>
          ${item.horaires ? `<div class="lvl-row">${infoDetail(item, 'horaires')}</div>` : ''}

          <div class="info-item" style="flex-direction:column;align-items:flex-start;gap:0.35rem;">
            <span class="info-label">Trouver les informations manquantes :</span>
            <div style="display:flex;flex-wrap:wrap;gap:0.35rem;">
              <a class="btn btn-secondary btn-sm" href="${escapeHtml(item.google_maps_url)}" target="_blank" rel="noopener" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Google Maps ↗</a>
              <a class="btn btn-secondary btn-sm" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Recherche Google ↗</a>
              <a class="btn btn-secondary btn-sm" href="https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui=${encodeURIComponent(item.nom)}&ou=${encodeURIComponent(item.commune + ' (' + item.code_postal + ')')}" target="_blank" rel="noopener" style="font-size:0.7rem;padding:0.2rem 0.5rem;">PagesJaunes ↗</a>
              ${item.osm_url ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(item.osm_url)}" target="_blank" rel="noopener" style="font-size:0.7rem;padding:0.2rem 0.5rem;">Fiche OpenStreetMap ↗</a>` : ''}
            </div>
            <span style="font-size:0.7rem;color:var(--text-muted);">Saisissez ce que vous trouvez dans les champs ci-dessus puis « Enregistrer » : la source affichée sera « saisie manuelle ».</span>
          </div>

          <div class="info-item">
            <span class="info-label">Catégories :</span>
            <div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.2rem;">
              ${(item.categories || [item.assortiment]).map(cat => `<span class="badge-specialty">📖 ${escapeHtml(cat)}</span>`).join('')}
            </div>
          </div>
          <div class="lvl-row">${niveauBadge({ niveau: 'officiel', source: 'Liste officielle (Ministère de la Culture)' })}
            <div class="lvl-note">Nom, commune, catégories${item.label_qualite ? ' et label ' + escapeHtml(item.label_qualite) : ''}${(item.autres_noms || []).length ? ' — aussi listée sous : ' + escapeHtml(item.autres_noms.join(', ')) : ''}</div>
          </div>
          ${item.lignes_officielles > 1 ? `
          <p style="font-size:0.7rem;color:var(--text-muted);margin:0;">
            Cette fiche regroupe ${item.lignes_officielles} lignes de la liste officielle (rayons ou magasins de la même librairie dans la commune).
          </p>` : ''}
        </div>
      </div>

      <div class="drawer-section">
        <h3>💼 Suivi de la prospection</h3>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
          <div class="form-group">
            <label for="drawer-status-select">Statut commercial</label>
            <select id="drawer-status-select" class="form-control">
              ${STATUS_OPTIONS.map(s => `<option value="${s.key}" ${item.statut_prospection === s.key ? 'selected' : ''}>${s.icon} ${s.label}</option>`).join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="drawer-priority-select">Priorité</label>
            <select id="drawer-priority-select" class="form-control">
              <option value="HAUTE" ${item.priorite === 'HAUTE' ? 'selected' : ''}>🔥 Haute</option>
              <option value="MOYENNE" ${item.priorite === 'MOYENNE' ? 'selected' : ''}>Moyenne</option>
              <option value="BASSE" ${item.priorite === 'BASSE' ? 'selected' : ''}>Basse</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label for="drawer-contact-name">Interlocuteur / acheteur</label>
          <input type="text" id="drawer-contact-name" class="form-control" value="${escapeHtml(item.contact_referent || '')}" placeholder="À renseigner (ex. responsable du rayon littérature)">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
          <div class="form-group">
            <label for="drawer-last-date">Dernière action</label>
            <input type="date" id="drawer-last-date" class="form-control" value="${escapeHtml(item.date_derniere_action || '')}">
          </div>
          <div class="form-group">
            <label for="drawer-next-date">Prochaine relance</label>
            <input type="date" id="drawer-next-date" class="form-control" value="${escapeHtml(item.date_relance || '')}">
          </div>
        </div>

        <div class="form-group">
          <label for="drawer-notes">Notes et comptes-rendus</label>
          <textarea id="drawer-notes" class="form-control" rows="4" placeholder="Compte-rendu de l'appel, retours sur le catalogue...">${escapeHtml(item.notes_prospection || '')}</textarea>
        </div>

        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
          <button class="btn btn-gold" onclick="generatePublisherPitchEmail(${item.id})" style="flex:1;">
            ✉️ Préparer un email de présentation
          </button>
        </div>
      </div>
    `;
  }

  if (backdrop) backdrop.classList.add('active');
  wireDrawerAutosave();
  saveUiState();
}

function closeDrawer() {
  // Ce qui vient d'être tapé (ou rempli automatiquement) est enregistré avant de fermer
  flushDrawer();
  const invalid = collectDrawerPatch().invalid;
  if (invalid.length) showToast(`Non enregistré (valeur incomplète) : ${invalid.join(', ')}.`);
  const backdrop = document.getElementById('drawer-backdrop');
  const wasOpen = backdrop && backdrop.classList.contains('active');
  if (backdrop) backdrop.classList.remove('active');
  Suivi.flush(); // fiche fermée : envoi en ligne de ce qui a été modifié
  if (wasOpen && state.listDirty) {
    state.listDirty = false;
    applyFilters();
    renderActiveView();
    updateKpis();
  }
  saveUiState();
}

/**
 * 14. Sauvegarde des Modifications de Prospection (LocalStorage)
 */
function saveDrawerModifications() {
  // Tout est déjà enregistré au fil de la frappe : ce bouton ferme simplement la fiche
  closeDrawer();
}

/**
 * Mise à jour rapide du statut depuis le tableau
 */
function updateBookstoreStatus(id, newStatus) {
  setSuivi(id, { statut_prospection: newStatus });
  applyFilters();
  updateKpis();
  showToast(`Statut mis à jour : ${formatStatusName(newStatus)}`);
}

/**
 * 15. Générateur d'Email Type pour l'Éditeur
 */
function generatePublisherPitchEmail(id) {
  const item = state.bookstores.find(b => b.id === id);
  if (!item) return;

  // Modèle volontairement neutre : les éléments entre crochets sont à compléter par l'éditeur
  const subject = encodeURIComponent(`Présentation de notre catalogue - ${item.nom}`);
  const body = encodeURIComponent(
`Bonjour ${item.contact_referent || ''},

Je me permets de vous contacter au nom de [nom de la maison d'édition].
[Une phrase personnalisée sur la librairie ${item.nom} à ${item.commune}.]

Nous aimerions vous présenter notre programme de parutions [domaines / titres phares] et, si cela vous intéresse, vous faire parvenir un ou deux exemplaires.

Diffusion / distribution : [à compléter]
Conditions libraires : [remise, retours : à compléter]

Seriez-vous d'accord pour recevoir notre catalogue par courrier ou en PDF ?

Bien cordialement,
[Prénom Nom]
[Téléphone]
`
  );

  const to = safeEmail(item.email);
  window.open(`mailto:${to}?subject=${subject}&body=${body}`, '_blank');
  showToast(to ? "Modèle d'email ouvert dans votre messagerie (à compléter)." : "Modèle ouvert : email de la librairie à récupérer.");
}

/**
 * 16. EXPORTS (CSV EXCEL & JSON)
 */
function exportCSV() {
  const items = state.filteredBookstores;
  if (!items || items.length === 0) {
    showToast("Aucune donnée à exporter.");
    return;
  }
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lvl = (b, k) => {
    const i = b.info && b.info[k];
    return i ? `${(NIVEAUX[i.niveau] || {}).label || ''} (${i.source}${i.date ? ', ' + i.date : ''})` : '';
  };
  const headers = [
    "ID", "Nom", "Autres noms", "Favori", "Commune", "Code postal", "Département", "Région", "Catégories", "Label",
    "Adresse", "Fiabilité adresse", "SIRET", "Fiabilité SIRET", "NAF",
    "Téléphone", "Fiabilité téléphone", "Email", "Fiabilité email", "Site web", "Fiabilité site", "Horaires", "Fiabilité horaires",
    "Note Google", "Fiche et avis Google", "Statut prospection", "Priorité", "Interlocuteur",
    "Notes", "Dernière action", "Prochaine relance"
  ];
  const rows = items.map(b => [
    b.id, b.nom, (b.autres_noms || []).join(', '), b.is_favorite ? 'OUI' : 'NON', b.commune, b.code_postal,
    `${b.departement_nom} (${b.departement_code})`, b.region, (b.categories || [b.assortiment]).join(', '), b.label_qualite || '',
    b.adresse || 'À récupérer', lvl(b, 'adresse'), b.siret || (b.sirene_statut === 'a_verifier' ? 'À vérifier' : 'À récupérer'), lvl(b, 'siret'), b.naf || '',
    b.telephone || 'À récupérer', lvl(b, 'telephone'), b.email || 'À récupérer', lvl(b, 'email'),
    b.site_web || 'À récupérer', lvl(b, 'site_web'), b.horaires || 'À récupérer', lvl(b, 'horaires'),
    b.google_rating != null ? `${b.google_rating} (${b.google_reviews_count ?? '?'} avis)` : '', b.google_maps_url,
    formatStatusName(b.statut_prospection), b.priorite, b.contact_referent || '',
    b.notes_prospection || '', b.date_derniere_action || '', b.date_relance || ''
  ].map(cell));
  const csvContent = "﻿" + [headers.map(cell).join(';'), ...rows.map(r => r.join(';'))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `librairies_prospection_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Export de ${items.length} librairies (CSV Excel).`);
}

function exportJSON() {
  const items = state.filteredBookstores;
  const jsonContent = JSON.stringify(items, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `librairies_export_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast("Export JSON généré avec succès !");
}

/**
 * 17. GUIDE DE PROSPECTION
 */
function openGuideModal() {
  const modal = document.getElementById('guide-modal');
  if (modal) modal.classList.add('active');
}

function closeGuideModal() {
  const modal = document.getElementById('guide-modal');
  if (modal) modal.classList.remove('active');
}

/**
 * Utilitaires
 */
function copyAddress(id) {
  const item = state.bookstores.find(b => b.id === id);
  if (!item || !item.adresse) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(item.adresse)
      .then(() => showToast("Adresse copiée dans le presse-papier."))
      .catch(() => showToast("Copie impossible dans ce navigateur."));
  }
}

function formatStatusName(status) {
  switch (status) {
    case 'A_CONTACTER': return 'À Contacter';
    case 'CONTACTE': return 'Contacté';
    case 'CATALOGUE_ENVOYE': return 'Catalogue Envoyé';
    case 'RDV_PRIS': return 'RDV Fixé';
    case 'CLIENT_ACTIF': return 'Client Actif';
    case 'A_RELANCER': return 'À Relancer';
    default: return status;
  }
}

function getStatusColor(status) {
  switch (status) {
    case 'A_CONTACTER': return 'var(--status-a-contacter)';
    case 'CONTACTE': return 'var(--status-contacte)';
    case 'CATALOGUE_ENVOYE': return 'var(--status-catalogue)';
    case 'RDV_PRIS': return 'var(--status-rdv)';
    case 'CLIENT_ACTIF': return 'var(--status-client)';
    case 'A_RELANCER': return 'var(--status-relance)';
    default: return 'var(--border-subtle)';
  }
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>✨</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/**
 * 18. FIABILITÉ DE L'AFFICHAGE
 * Toute information affichée vient d'une source identifiée. Sinon :
 *   « À récupérer » : information pas encore trouvée ;  « À vérifier » : information incertaine.
 */
const STATUS_OPTIONS = [
  { key: 'A_CONTACTER', label: 'À contacter', icon: '📥' },
  { key: 'CONTACTE', label: 'Contacté', icon: '📞' },
  { key: 'CATALOGUE_ENVOYE', label: 'Catalogue envoyé', icon: '📖' },
  { key: 'RDV_PRIS', label: 'RDV pris', icon: '🤝' },
  { key: 'CLIENT_ACTIF', label: 'Client actif', icon: '⭐' },
  { key: 'A_RELANCER', label: 'À relancer', icon: '⏰' }
];

const SIRENE_STATUS_LABELS = {
  verifie: 'Vérifié (SIRENE)',
  manuel: 'Confirmé manuellement',
  a_verifier: 'À vérifier',
  non_trouve: 'À récupérer'
};

const NAF_LABELS = {
  '47.61Z': 'Commerce de détail de livres',
  '47.62Z': 'Journaux et papeterie',
  '56.30Z': 'Débit de boissons',
  '56.10A': 'Restauration traditionnelle',
  '56.10C': 'Restauration rapide',
  '47.79Z': "Biens d'occasion",
  '47.78C': 'Autres commerces spécialisés',
  '47.19B': 'Magasin non alimentaire',
  '58.11Z': 'Édition de livres',
  '91.02Z': 'Musée',
  '91.03Z': 'Monument historique',
  '94.91Z': 'Organisation religieuse',
  '94.99Z': 'Association'
};

// Liens construits à partir de données externes : jamais injectés sans contrôle
function safeTel(v) {
  const s = String(v || '').replace(/[^\d+]/g, '');
  return /^\+?\d{6,15}$/.test(s) ? s : '';
}
function safeEmail(v) {
  const s = String(v || '').trim();
  return /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}$/i.test(s) ? s : '';
}
function safeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.href : '';
  } catch (e) {
    return '';
  }
}

function sourceTag(source) {
  return source ? `<span class="data-source">${escapeHtml(source)}</span>` : '';
}
const MISSING = '<span class="data-missing">À récupérer</span>';

function fieldHtml(item, key) {
  return item[key] ? `${escapeHtml(item[key])} ${infoBadge(item, key, true)}` : MISSING;
}

function phoneHtml(item) {
  const tel = safeTel(item.telephone);
  if (!item.telephone) return MISSING;
  return tel
    ? `<a href="tel:${tel}" style="color:var(--text-primary);text-decoration:none;font-weight:600;">${escapeHtml(item.telephone)}</a> ${infoBadge(item, 'telephone', true)}`
    : `<span class="data-check">${escapeHtml(item.telephone)} — à vérifier</span>`;
}

function emailHtml(item) {
  const mail = safeEmail(item.email);
  if (!item.email) return MISSING;
  return mail
    ? `<a href="mailto:${escapeHtml(mail)}" style="color:var(--text-cyan);text-decoration:none;">${escapeHtml(item.email)}</a> ${infoBadge(item, 'email', true)}`
    : `<span class="data-check">${escapeHtml(item.email)} — à vérifier</span>`;
}

function ratingHtml(item, compact) {
  // Note Google payante à récupérer : à défaut, lien vers la fiche Google Maps (avis, photos, horaires)
  if (item.google_rating == null) {
    return `<a href="${escapeHtml(item.google_maps_url)}" target="_blank" rel="noopener" class="google-link" title="Recherche Google Maps : nom + librairie + ville (ouvre en général directement la fiche)">Voir les avis Google ↗</a>`;
  }
  const count = item.google_reviews_count != null ? ` (${item.google_reviews_count} avis)` : '';
  return `<span class="rating-badge">⭐ ${escapeHtml(item.google_rating)} / 5</span><span class="reviews-count">${count}</span> ${infoBadge(item, 'google', true)}`;
}

function addressHtml(item) {
  if (item.adresse) return `${escapeHtml(item.adresse)} ${infoBadge(item, 'adresse', true)}`;
  return `${escapeHtml(item.commune)} (${escapeHtml(item.code_postal)}) — adresse <span class="data-missing">à récupérer</span>`;
}

function sireneStatus(item) {
  if (item.siret) return item.info?.siret?.niveau || 'verifie';
  return item.sirene_statut === 'a_verifier' ? 'a_verifier' : 'non_trouve';
}

function siretHtml(item) {
  if (item.siret) return `<span style="font-family:var(--font-mono);">${escapeHtml(item.siret)}</span> ${infoBadge(item, 'siret', true)}`;
  if (item.sirene_statut === 'a_verifier') return '<span class="data-check">⚠️ À vérifier (piste dans la fiche)</span>';
  return MISSING;
}

/**
 * Recherche SIRENE en direct depuis la fiche (API publique Recherche d'entreprises).
 * L'utilisateur choisit lui-même le bon établissement : rien n'est retenu automatiquement.
 */
async function searchSireneLive(id) {
  const item = state.bookstores.find(b => b.id === id);
  const box = document.getElementById('sirene-live-results');
  if (!item || !box) return;
  box.innerHTML = '<p style="font-size:0.75rem;color:var(--text-muted);">Recherche en cours…</p>';

  try {
    const params = new URLSearchParams({ q: item.nom, code_postal: item.code_postal, per_page: '10' });
    const res = await fetch(`https://recherche-entreprises.api.gouv.fr/search?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const candidates = [];
    (json.results || []).forEach(r => (r.matching_etablissements || []).forEach(e => {
      if (e.etat_administratif !== 'A') return;
      if (e.code_postal !== item.code_postal && e.commune !== item.code_commune) return;
      candidates.push({
        siret: e.siret, siren: r.siren, nom: r.nom_complet, adresse: e.adresse, naf: e.activite_principale,
        latitude: parseFloat(e.latitude), longitude: parseFloat(e.longitude)
      });
    }));
    state.sireneLive = { id, candidates };

    if (!candidates.length) {
      box.innerHTML = '<p style="font-size:0.75rem;color:var(--text-muted);">Aucun établissement actif trouvé sous ce nom dans ce code postal. Essayez l\'Annuaire des entreprises (lien ci-dessus) avec un autre nom.</p>';
      return;
    }
    box.innerHTML = `
      <p style="font-size:0.72rem;color:var(--text-muted);margin:0.4rem 0;">Établissements actifs du même code postal — choisissez le bon s'il y est :</p>
      ${candidates.map((c, i) => `
        <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:0.45rem;margin-bottom:0.35rem;font-size:0.75rem;">
          <strong>${escapeHtml(c.nom)}</strong><br>
          ${escapeHtml(c.adresse)}<br>
          SIRET ${escapeHtml(c.siret)} — NAF ${escapeHtml(c.naf)} ${NAF_LABELS[c.naf] ? '(' + NAF_LABELS[c.naf] + ')' : ''}
          <div style="text-align:right;margin-top:0.25rem;">
            <button class="btn btn-primary btn-sm" onclick="confirmSirene(${id}, ${i})" style="font-size:0.7rem;padding:0.2rem 0.5rem;">✔ C'est cette librairie</button>
          </div>
        </div>
      `).join('')}
    `;
  } catch (e) {
    box.innerHTML = `<p style="font-size:0.75rem;color:var(--accent-rose);">Recherche impossible (${escapeHtml(e.message)}). Vérifiez la connexion Internet.</p>`;
  }
}

function confirmSirene(id, index) {
  const c = state.sireneLive && state.sireneLive.id === id ? state.sireneLive.candidates[index] : null;
  if (!c) return;
  setSuivi(id, {
    sirene_confirme: {
      siret: c.siret, siren: c.siren, nom: c.nom, naf: c.naf, adresse: c.adresse,
      latitude: Number.isFinite(c.latitude) ? c.latitude : null,
      longitude: Number.isFinite(c.longitude) ? c.longitude : null,
      date: new Date().toISOString().slice(0, 10)
    }
  });
  state.needsFitBounds = false;
  applyFilters();
  renderActiveView();
  openDrawer(id);
  showToast('SIRET et adresse enregistrés (confirmés par vous).');
}

/**
 * Liste des assortiments générée depuis les données (aucune catégorie inventée)
 */
function populateSpecialtySelect() {
  const select = document.getElementById('filter-specialty');
  if (!select) return;
  const counts = {};
  state.bookstores.forEach(b => (b.categories || [b.assortiment]).forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  select.innerHTML =
    '<option value="ALL">📖 Tous les assortiments</option>' +
    Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${n})</option>`).join('');
  select.value = state.filters.specialty;
}

/**
 * 19. NIVEAUX DE FIABILITÉ
 * Chaque information porte { source, niveau, date, note } (champ « info » des données).
 */
const NIVEAUX = {
  officiel: { label: 'Officiel', icon: '🏛️', cls: 'lvl-officiel', aide: 'Liste officielle du Ministère de la Culture.' },
  verifie: { label: 'Vérifié', icon: '✅', cls: 'lvl-verifie', aide: 'Source fiable et correspondance certaine, ou deux sources qui concordent.' },
  probable: { label: 'Probable', icon: '🟡', cls: 'lvl-probable', aide: 'Source sérieuse mais non garantie : à confirmer au premier contact.' },
  a_verifier: { label: 'À vérifier', icon: '⚠️', cls: 'lvl-averifier', aide: 'Information incertaine : ancienne, approximative ou contradictoire.' },
  saisie: { label: 'Saisi par vous', icon: '✍️', cls: 'lvl-saisie', aide: 'Information saisie ou confirmée par vous.' }
};

function formatDateFr(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function niveauBadge(info, compact) {
  if (!info) return '';
  const n = NIVEAUX[info.niveau] || NIVEAUX.probable;
  const details = [info.source ? `Source : ${info.source}` : '', info.date ? `du ${formatDateFr(info.date)}` : '', info.note || '']
    .filter(Boolean).join(' — ');
  const text = compact || !info.source ? n.label : `${n.label} · ${info.source}`;
  return `<span class="lvl ${n.cls}" title="${escapeHtml(n.label + (details ? ' — ' + details : ''))}">${n.icon} ${escapeHtml(text)}</span>`;
}

const infoBadge = (item, key, compact) => niveauBadge(item.info && item.info[key], compact);

// Badge complet + explication en clair (date, motif) : utilisé dans la fiche détaillée
function infoDetail(item, key) {
  const i = item.info && item.info[key];
  if (!i) return '';
  const extra = [i.date ? `information du ${formatDateFr(i.date)}` : '', i.note || ''].filter(Boolean).join(' — ');
  return `${niveauBadge(i)}${extra ? `<div class="lvl-note">${escapeHtml(extra)}</div>` : ''}`;
}

/**
 * 20. SUIVI : application des saisies de l'utilisateur sur les données
 */
const CRM_FIELDS = ['statut_prospection', 'priorite', 'contact_referent', 'notes_prospection', 'date_derniere_action', 'date_relance', 'is_favorite'];

function applySuivi(item, e) {
  if (!e) return item;
  item.info = { ...(item.info || {}) };
  CRM_FIELDS.forEach(k => { if (e[k] !== undefined) item[k] = e[k]; });
  for (const [k, s] of Object.entries(e.saisies || {})) {
    if (s && s.valeur) {
      item[k] = s.valeur;
      item.info[k] = { source: 'Saisie manuelle', niveau: 'saisie', date: s.date };
    } else {
      item[k] = '';
      delete item.info[k];
    }
  }
  const c = e.sirene_confirme;
  if (c && c.siret) {
    const info = { source: 'SIRENE, confirmé par vous', niveau: 'saisie', date: c.date };
    Object.assign(item, { siret: c.siret, siren: c.siren || '', nom_officiel: c.nom || '', naf: c.naf || '', sirene_statut: 'saisie' });
    item.info.siret = info;
    if (c.adresse) { item.adresse = c.adresse; item.info.adresse = info; }
    if (Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
      Object.assign(item, { latitude: c.latitude, longitude: c.longitude, localisation: 'adresse' });
      item.info.position = info;
    }
  }
  return item;
}

const cloneItem = b => JSON.parse(JSON.stringify(b));

function applySuiviToAll() {
  const entries = Suivi.all();
  state.bookstores = [...state.baseById.values()].map(b => applySuivi(cloneItem(b), entries[b.id]));
}

// Point d'entrée UNIQUE pour toute modification : enregistre puis met à jour la fiche affichée
function setSuivi(id, patch) {
  Suivi.update(id, patch);
  const base = state.baseById.get(id);
  const updated = applySuivi(cloneItem(base), Suivi.all()[id]);
  const idx = state.bookstores.findIndex(b => b.id === id);
  if (idx !== -1) state.bookstores[idx] = updated;
  if (state.selectedBookstore && state.selectedBookstore.id === id) state.selectedBookstore = updated;
  return updated;
}

/**
 * 21. INDICATEUR ET ÉCRAN DE SAUVEGARDE
 */
const SAVE_STATES = {
  local: { icon: '💾', text: 'Enregistré sur cet appareil', cls: 'save-wait' },
  attente: { icon: '💾', text: 'Enregistré sur cet appareil (envoi en ligne à la fermeture de la fiche)', cls: 'save-wait' },
  synchro: { icon: '⏳', text: 'Enregistrement…', cls: 'save-wait' },
  ok: { icon: '☁️', text: 'Tout est enregistré', cls: 'save-ok' },
  hors_ligne: { icon: '📴', text: 'Hors ligne : enregistré sur cet appareil, envoi dès le retour d\'Internet', cls: 'save-wait' },
  erreur: { icon: '⚠️', text: 'Sauvegarde en ligne en échec', cls: 'save-error' },
  non_configure: { icon: '⚠️', text: 'Sauvegarde en ligne à activer', cls: 'save-error' }
};

function initSaveStatus() {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.addEventListener('click', openSaveSettings);
  Suivi.onStatus(st => {
    const s = SAVE_STATES[st.etat] || SAVE_STATES.local;
    el.className = `save-status ${s.cls}`;
    el.innerHTML = `<span>${s.icon}</span><span class="save-text">${escapeHtml(s.text)}</span>`;
    const last = Suivi.lastSync();
    el.title = [s.text, st.message, last ? `Dernier envoi : ${new Date(last).toLocaleString('fr-FR')}` : '', 'Cliquer pour les réglages de sauvegarde']
      .filter(Boolean).join('\n');
  });
  Suivi.onRemoteChange = () => {
    applySuiviToAll();
    applyFilters();
    renderActiveView();
    updateKpis();
    if (state.selectedClient && document.getElementById('drawer-backdrop')?.classList.contains('active')) openClient(state.selectedClient);
  };
}

function openSaveSettings() {
  const cfg = Suivi.getConfig();
  let modal = document.getElementById('save-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'save-modal';
    modal.className = 'modal-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-card" style="max-width:640px;">
      <div class="modal-header">
        <h3 style="font-family:var(--font-heading);font-weight:700;">☁️ Sauvegarde du suivi</h3>
        <button class="drawer-close-btn" onclick="document.getElementById('save-modal').classList.remove('active')">✕</button>
      </div>
      <div class="modal-body">
        <p>Chaque modification (statut, notes, favoris, coordonnées saisies) est <strong>enregistrée immédiatement sur cet appareil</strong>,
        puis <strong>envoyée automatiquement dans un espace privé sur GitHub</strong> : rien à exporter, et rien n'est perdu en cas de plantage
        ou de changement d'ordinateur. Toutes les versions restent consultables.</p>

        <form id="save-form" onsubmit="submitSaveSettings(event)" autocomplete="on">
          <input type="text" name="username" autocomplete="username" value="biblio-prospect" style="display:none;" readonly>
          <div class="form-group">
            <label for="save-token">Clé d'accès GitHub</label>
            <input type="password" id="save-token" name="password" class="form-control" autocomplete="current-password"
              placeholder="github_pat_…" value="${escapeHtml(cfg.token)}">
          </div>
          <details style="margin-bottom:0.75rem;font-size:0.8rem;">
            <summary>Réglages avancés (espace de sauvegarde)</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-top:0.5rem;">
              <div class="form-group"><label for="save-owner">Compte GitHub</label><input id="save-owner" class="form-control" value="${escapeHtml(cfg.owner)}"></div>
              <div class="form-group"><label for="save-repo">Dépôt privé</label><input id="save-repo" class="form-control" value="${escapeHtml(cfg.repo)}"></div>
            </div>
          </details>
          <div id="save-test-result" style="font-size:0.8rem;margin-bottom:0.5rem;"></div>
          <button type="submit" class="btn btn-primary">Tester et enregistrer</button>
          ${cfg.token ? `<a class="btn btn-secondary" href="${escapeHtml(Suivi.historyUrl())}" target="_blank" rel="noopener" style="margin-left:0.5rem;">Historique des sauvegardes ↗</a>` : ''}
        </form>

        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:1rem;">
          La clé est conservée dans ce navigateur. Safari propose de l'enregistrer dans les mots de passe : acceptez,
          elle sera remplie automatiquement si elle devait être redemandée. La clé vous est fournie par la personne qui a installé l'outil
          (création : voir le fichier LISEZMOI).
        </p>
      </div>
    </div>`;
  modal.classList.add('active');
}

async function submitSaveSettings(event) {
  event.preventDefault();
  const result = document.getElementById('save-test-result');
  const cfg = {
    token: document.getElementById('save-token').value.trim(),
    owner: document.getElementById('save-owner').value.trim() || 'niko2020',
    repo: document.getElementById('save-repo').value.trim() || 'biblio-prospect-donnees'
  };
  if (!cfg.token) { result.innerHTML = '<span class="data-check">Collez la clé d\'accès.</span>'; return; }
  result.textContent = 'Test en cours…';
  const test = await Suivi.testConfig(cfg);
  if (!test.ok) {
    result.innerHTML = `<span style="color:var(--accent-rose);">❌ ${escapeHtml(test.message)}</span>`;
    return;
  }
  result.innerHTML = '<span style="color:var(--accent-emerald);">✅ Sauvegarde en ligne activée.</span>';
  const changed = await Suivi.pull();
  if (changed && Suivi.onRemoteChange) Suivi.onRemoteChange();
  setTimeout(() => document.getElementById('save-modal')?.classList.remove('active'), 1200);
}

/**
 * 22. ENREGISTREMENT AU FIL DE LA FRAPPE (fiche ouverte)
 * Chaque champ de la fiche est enregistré moins d'une seconde après la frappe : rien n'est perdu
 * en cas de rafraîchissement, de fermeture de la page ou de plantage.
 */
let drawerTimer = null;
const DRAWER_AUTOSAVE_MS = 700;

function collectDrawerPatch() {
  const item = state.selectedBookstore && state.bookstores.find(b => b.id === state.selectedBookstore.id);
  const patch = {};
  const invalid = [];
  if (!item || !document.getElementById('drawer-notes')) return { patch, invalid, item };
  const val = elId => (document.getElementById(elId)?.value ?? '').trim();

  const crm = {
    statut_prospection: 'drawer-status-select', priorite: 'drawer-priority-select', contact_referent: 'drawer-contact-name',
    date_derniere_action: 'drawer-last-date', date_relance: 'drawer-next-date', notes_prospection: 'drawer-notes'
  };
  for (const [field, elId] of Object.entries(crm)) {
    if (!document.getElementById(elId)) continue;
    // Les notes gardent leurs retours à la ligne et espaces internes
    const v = field === 'notes_prospection' ? (document.getElementById(elId).value || '') : val(elId);
    if (v !== (item[field] || '')) patch[field] = v;
  }

  const saisies = {};
  const contactFields = [
    ['telephone', 'drawer-input-tel', safeTel, 'téléphone'],
    ['email', 'drawer-input-email', safeEmail, 'email'],
    ['site_web', 'drawer-input-site', safeUrl, 'site web'],
    ['horaires', 'drawer-input-horaires', v => v, 'horaires']
  ];
  for (const [field, elId, check, label] of contactFields) {
    const v = val(elId);
    if (v === (item[field] || '')) continue;
    if (v && !check(v)) { invalid.push(label); continue; }
    saisies[field] = { valeur: v, date: new Date().toISOString().slice(0, 10) };
  }
  if (Object.keys(saisies).length) patch.saisies = saisies;
  return { patch, invalid, item };
}

function setDrawerSaveHint(text, warn) {
  const el = document.getElementById('drawer-save-hint');
  if (!el) return;
  el.textContent = text;
  el.style.color = warn ? 'var(--accent-gold)' : 'var(--text-muted)';
}

function scheduleDrawerAutosave() {
  setDrawerSaveHint('Enregistrement…');
  clearTimeout(drawerTimer);
  drawerTimer = setTimeout(autosaveDrawer, DRAWER_AUTOSAVE_MS);
}

function autosaveDrawer() {
  clearTimeout(drawerTimer);
  drawerTimer = null;
  const { patch, invalid, item } = collectDrawerPatch();
  if (!item) return;
  if (Object.keys(patch).length) {
    setSuivi(item.id, patch);
    state.listDirty = true; // la liste sera rafraîchie à la fermeture de la fiche
  }
  if (invalid.length) setDrawerSaveHint(`✓ Enregistré, sauf : ${invalid.join(', ')} (valeur incomplète)`, true);
  else setDrawerSaveHint('✓ Enregistré automatiquement');
}

// Enregistre la fiche ouverte quoi qu'il arrive (fermeture, rafraîchissement, onglet caché)
function flushDrawer() {
  const open = document.getElementById('drawer-backdrop')?.classList.contains('active');
  if (open || drawerTimer) autosaveDrawer();
}

function wireDrawerAutosave() {
  const body = document.getElementById('drawer-content-body');
  if (!body) return;
  body.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.closest('#sirene-live-results')) return;
    el.addEventListener('input', scheduleDrawerAutosave);
    el.addEventListener('change', scheduleDrawerAutosave);
  });
  setDrawerSaveHint('Les modifications sont enregistrées automatiquement');
}

/**
 * 23. MÉMOIRE DE L'INTERFACE
 * Onglet, filtres, recherche, position de la carte et fiche ouverte sont retenus : après un
 * rafraîchissement (ou à la prochaine ouverture), on se retrouve au même endroit.
 */
const UI_KEY = 'biblio_interface_v1';

function saveUiState() {
  if (!state.uiReady) return; // pas avant d'avoir relu l'état mémorisé (sinon il serait écrasé)
  const backdrop = document.getElementById('drawer-backdrop');
  const isOpen = backdrop && backdrop.classList.contains('active');
  const open = isOpen && state.selectedBookstore ? state.selectedBookstore.id : null;
  const client = isOpen && !state.selectedBookstore && state.selectedClient ? state.selectedClient : null;
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ view: state.activeView, filters: state.filters, ouverte: open, client, carte: state.mapView || null }));
  } catch (e) { /* stockage indisponible : sans gravité */ }
}

function restoreUiState() {
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) { ui = {}; }
  // Ancienne option « Cible principale » de la liste des assortiments : convertie en étiquette activée
  if (ui.filters && ui.filters.specialty === 'EXCLUDE_JBM') { ui.filters.specialty = 'ALL'; ui.filters.excludeJBM = true; }
  if (ui.filters && typeof ui.filters === 'object') {
    for (const k of Object.keys(state.filters)) {
      if (ui.filters[k] !== undefined && typeof ui.filters[k] === typeof state.filters[k]) state.filters[k] = ui.filters[k];
    }
  }
  if (ui.carte && Number.isFinite(ui.carte.lat) && Number.isFinite(ui.carte.lng) && Number.isFinite(ui.carte.zoom)) {
    state.mapView = ui.carte;
  }
  return ui;
}

// Met les listes, la recherche et les étiquettes de filtre en accord avec state.filters
function syncControlsFromState() {
  const f = state.filters;
  const setSel = (elId, v) => { const el = document.getElementById(elId); if (el) { el.value = v; if (el.value !== v) el.value = el.options[0] ? el.options[0].value : ''; } };
  setSel('filter-region', f.region);
  populateDepartmentSelect();
  setSel('filter-department', f.department);
  setSel('filter-specialty', f.specialty);
  setSel('filter-status', f.status);
  setSel('filter-sort', f.sortBy);
  // Une valeur mémorisée qui n'existe plus (ex. département disparu) revient à « tous »
  ['region', 'department', 'specialty', 'status'].forEach((k, i) => {
    const el = document.getElementById(['filter-region', 'filter-department', 'filter-specialty', 'filter-status'][i]);
    if (el) f[k] = el.value || 'ALL';
  });
  const search = document.getElementById('global-search-input');
  if (search) search.value = f.search || '';
  const clear = document.getElementById('search-clear-btn');
  if (clear) clear.style.display = f.search ? 'block' : 'none';
  document.querySelectorAll('.tag-chip').forEach(chip => {
    const type = chip.getAttribute('data-filter-type');
    const val = chip.getAttribute('data-filter-val');
    const v = f[type];
    chip.classList.toggle('active', typeof v === 'boolean' ? v : v === val);
  });
}

// Dernière chance avant de quitter ou rafraîchir : enregistrer la frappe en cours et la position
window.addEventListener('pagehide', () => { flushDrawer(); saveUiState(); });
window.addEventListener('beforeunload', () => { flushDrawer(); saveUiState(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flushDrawer(); saveUiState(); }
});
