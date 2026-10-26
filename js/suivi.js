/**
 * BIBLIO-PROSPECT — Enregistrement du suivi de prospection
 *
 * Le « suivi » = tout ce que l'utilisateur saisit : statut, priorité, interlocuteur, notes, dates,
 * favoris, coordonnées saisies à la main, SIRET confirmés.
 *
 * 1. Chaque modification est écrite IMMÉDIATEMENT dans le navigateur (survit à un plantage,
 *    à une fermeture, à une coupure Internet).
 * 2. Quelques secondes plus tard, elle est envoyée dans un dépôt GitHub PRIVÉ (fichier suivi.json) :
 *    sauvegarde durable, retrouvée sur un autre navigateur ou ordinateur, avec l'historique complet
 *    de toutes les versions (chaque envoi est une version consultable sur GitHub).
 * 3. Au démarrage, la version GitHub est rechargée et fusionnée avec celle du navigateur
 *    (pour chaque librairie, la modification la plus récente l'emporte).
 */
const Suivi = (() => {
  const LOCAL_KEY = 'biblio_suivi_v1';
  const CONFIG_KEY = 'biblio_suivi_config';
  const OLD_KEY = 'biblio_prospect_crm_mods'; // ancienne version (navigateur seul)
  const FILE = 'suivi.json';
  // Envoi vers GitHub aux moments naturels (fiche fermée, page quittée) et au plus tard après ce délai :
  // chaque envoi = un commit, on évite donc d'en faire un par frappe (limites et taille de l'historique GitHub)
  const PUSH_MAX_DELAY_MS = 120000;
  const RETRY_MS = 60000;

  const DEFAULT_CONFIG = { owner: 'niko2020', repo: 'biblio-prospect-donnees', token: '' };

  // Collections de gestion (dépôt-vente) : chaque élément porte « maj » (date de dernière modification)
  const COLLECTIONS = ['pdv', 'titres', 'mouvements', 'factures', 'anomalies'];
  const emptyGestion = () => Object.fromEntries(COLLECTIONS.map(c => [c, {}]));

  // { data: { id librairie: entrée }, gestion: { collection: { id: élément } }, pending, sha, lastSync }
  let local = readLocal();
  let pushTimer = null;
  let busy = false;
  let status = { etat: 'local', message: '' };
  const listeners = [];

  function readJson(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function readLocal() {
    const v = readJson(LOCAL_KEY, null);
    if (v && v.data) return { ...v, gestion: { ...emptyGestion(), ...(v.gestion || {}) } };
    return { data: migrateOld(), gestion: emptyGestion(), pending: false, sha: null, lastSync: null };
  }

  // Un autre onglet (ou une ancienne version restée ouverte) a pu enregistrer entre-temps dans ce navigateur :
  // on reprend ses modifications plus récentes, élément par élément, avant d'écrire (sinon on les effacerait)
  function fusionnerStockage() {
    const s = readJson(LOCAL_KEY, null);
    if (!s || !s.data) return;
    local.data = mergeMaps(s.data, local.data).merged;
    const g = s.gestion || {};
    for (const c of new Set([...Object.keys(g), ...Object.keys(local.gestion)])) {
      local.gestion[c] = mergeMaps(g[c] || {}, local.gestion[c] || {}).merged;
    }
    if (s.pending) local.pending = true;
  }

  // Onglet mis en pause (l'outil est ouvert dans un autre onglet, qui a la main) : plus aucune écriture ni envoi
  let suspendu = false;
  function suspendre() {
    suspendu = true;
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  function writeLocal() {
    if (suspendu) return true;
    try {
      fusionnerStockage();
      localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
      return true;
    } catch (e) {
      setStatus('erreur', "Enregistrement impossible dans ce navigateur (stockage plein ou bloqué).");
      return false;
    }
  }

  // Conversion des données de l'ancienne version (une seule fois ; l'ancienne clé est gardée de côté)
  function migrateOld() {
    const old = readJson(OLD_KEY, null);
    if (!old) return {};
    const now = new Date().toISOString();
    const data = {};
    for (const [id, m] of Object.entries(old)) {
      const e = { maj: now };
      ['statut_prospection', 'priorite', 'contact_referent', 'notes_prospection', 'date_derniere_action', 'date_relance', 'is_favorite']
        .forEach(k => { if (m[k] !== undefined && m[k] !== '') e[k] = m[k]; });
      const src = m.sources || {};
      ['telephone', 'email', 'site_web', 'horaires'].forEach(k => {
        if (src[k] === 'Saisie manuelle' && m[k]) (e.saisies = e.saisies || {})[k] = { valeur: m[k], date: now.slice(0, 10) };
      });
      if (src.siret === 'Confirmé manuellement' && m.siret) {
        e.sirene_confirme = { siret: m.siret, siren: m.siren, nom: m.nom_officiel, naf: m.naf, adresse: m.adresse,
          latitude: m.latitude, longitude: m.longitude, date: now.slice(0, 10) };
      }
      if (Object.keys(e).length > 1) data[id] = e;
    }
    try {
      localStorage.setItem(OLD_KEY + '_ancien', JSON.stringify(old));
      localStorage.removeItem(OLD_KEY);
    } catch (e) { /* sans gravité */ }
    return data;
  }

  // ---------- Configuration de la sauvegarde en ligne ----------
  function getConfig() {
    return { ...DEFAULT_CONFIG, ...readJson(CONFIG_KEY, {}) };
  }
  function setConfig(cfg) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getConfig(), ...cfg }));
    } catch (e) { /* signalé par l'état */ }
  }
  const isConfigured = () => !!getConfig().token;

  // ---------- État affiché à l'utilisateur ----------
  function setStatus(etat, message) {
    status = { etat, message: message || '', date: new Date() };
    listeners.forEach(fn => { try { fn(status); } catch (e) { /* écouteur défaillant */ } });
  }
  function onStatus(fn) {
    listeners.push(fn);
    fn(status);
  }

  // ---------- Lecture / écriture des entrées ----------
  function all() { return local.data; }

  // Gestion : lecture d'une collection, écriture d'un élément (même mécanisme que le suivi)
  function collection(name) { return local.gestion[name] || {}; }

  function put(name, id, record) {
    if (!local.gestion[name]) local.gestion[name] = {};
    local.gestion[name][id] = { ...record, id, maj: new Date().toISOString() };
    local.pending = true;
    if (!writeLocal()) return false;
    schedulePush();
    return true;
  }

  function update(id, patch) {
    const prev = local.data[id] || {};
    const next = { ...prev, ...patch, maj: new Date().toISOString() };
    if (patch.saisies) next.saisies = { ...(prev.saisies || {}), ...patch.saisies };
    local.data[id] = next;
    local.pending = true;
    if (!writeLocal()) return false;
    schedulePush();
    return true;
  }

  // Regroupe sous l'identifiant principal les entrées enregistrées sous un ancien identifiant
  // (fiches fusionnées par la mise à jour des données)
  function remapAliases(aliasToMain) {
    let changed = false;
    for (const [alias, main] of Object.entries(aliasToMain)) {
      const e = local.data[alias];
      if (!e) continue;
      const m = local.data[main];
      if (!m || (e.maj || '') > (m.maj || '')) local.data[main] = { ...(m || {}), ...e, saisies: { ...((m || {}).saisies || {}), ...(e.saisies || {}) } };
      delete local.data[alias];
      changed = true;
    }
    if (changed) { local.pending = true; writeLocal(); schedulePush(); }
  }

  // ---------- GitHub ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

  async function api(method, body, accept = 'application/vnd.github+json') {
    const { owner, repo, token } = getConfig();
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${FILE}`;
    const res = await fetch(url + (method === 'GET' ? `?t=${Date.now()}` : ''), {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    return res;
  }

  function explain(res) {
    if (res.status === 401) return "Clé d'accès invalide ou expirée.";
    if (res.status === 403) return "La clé d'accès GitHub n'a pas le droit d'écrire dans le dépôt de sauvegarde.";
    if (res.status === 404) return 'Dépôt de sauvegarde introuvable (vérifier son nom et les droits de la clé).';
    return `Erreur GitHub ${res.status}`;
  }

  async function fetchRemote() {
    const res = await api('GET');
    if (res.status === 404) {
      // Fichier pas encore créé ? On distingue « dépôt absent » de « fichier absent »
      const { owner, repo, token } = getConfig();
      const repoRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' } });
      if (!repoRes.ok) throw new Error(explain(repoRes));
      return { data: {}, gestion: emptyGestion(), sha: null };
    }
    if (!res.ok) throw new Error(explain(res));
    const json = await res.json();
    let text = b64decode(json.content || '');
    if (!text && json.size > 0) {
      // Au-delà de 1 Mo, GitHub ne renvoie pas le contenu dans la réponse : lecture en brut
      const raw = await api('GET', null, 'application/vnd.github.raw');
      if (!raw.ok) throw new Error(explain(raw));
      text = await raw.text();
    }
    const parsed = JSON.parse(text || '{}');
    return { data: parsed.librairies || {}, gestion: { ...emptyGestion(), ...(parsed.gestion || {}) }, sha: json.sha };
  }

  // Fusion élément par élément : la modification la plus récente (« maj ») l'emporte
  function mergeMaps(remoteMap, localMap) {
    const merged = { ...remoteMap };
    let localNewer = false;
    for (const [id, e] of Object.entries(localMap || {})) {
      const r = remoteMap[id];
      if (!r || (e.maj || '') > (r.maj || '')) {
        merged[id] = e;
        if (!r || JSON.stringify(r) !== JSON.stringify(e)) localNewer = true;
      }
    }
    return { merged, localNewer };
  }

  function merge(remote) {
    const lib = mergeMaps(remote.data, local.data);
    let localNewer = lib.localNewer;
    const gestion = {};
    // Toutes les collections, y compris celles qu'une version plus récente aurait ajoutées : jamais effacées
    for (const c of new Set([...COLLECTIONS, ...Object.keys(remote.gestion || {}), ...Object.keys(local.gestion || {})])) {
      const m = mergeMaps((remote.gestion || {})[c] || {}, local.gestion[c] || {});
      gestion[c] = m.merged;
      localNewer = localNewer || m.localNewer;
    }
    return { merged: lib.merged, gestion, localNewer };
  }

  const snapshotOf = () => JSON.stringify([local.data, local.gestion]);

  // Aperçu de développement (sans clé) : charge un fichier suivi.json comme s'il venait de GitHub
  function loadSnapshot(parsed) {
    const m = merge({ data: parsed.librairies || {}, gestion: { ...emptyGestion(), ...(parsed.gestion || {}) } });
    local.data = m.merged;
    local.gestion = m.gestion;
    writeLocal();
  }

  async function pull() {
    if (suspendu) return false;
    if (!isConfigured()) { setStatus('non_configure'); return false; }
    if (busy) return false;
    busy = true;
    setStatus('synchro', 'Lecture de la sauvegarde…');
    try {
      const remote = await fetchRemote();
      const { merged, gestion, localNewer } = merge(remote);
      const changedFromLocal = JSON.stringify([merged, gestion]) !== snapshotOf();
      local.data = merged;
      local.gestion = gestion;
      local.sha = remote.sha;
      local.pending = local.pending || localNewer;
      local.lastSync = new Date().toISOString();
      writeLocal();
      busy = false;
      if (local.pending) await push();
      else setStatus('ok', 'Tout est enregistré');
      return changedFromLocal;
    } catch (e) {
      busy = false;
      setStatus(navigator.onLine === false ? 'hors_ligne' : 'erreur', navigator.onLine === false ? '' : e.message);
      return false;
    }
  }

  async function push(retry = true) {
    if (suspendu && !busy) return;
    if (!isConfigured()) { setStatus('non_configure'); return; }
    if (busy || !local.pending) return;
    busy = true;
    setStatus('synchro', 'Envoi…');
    const snapshot = snapshotOf();
    // Sans mise en forme : environ 30 % plus léger à chaque envoi et dans l'historique
    const content = JSON.stringify({ version: 2, enregistre_le: new Date().toISOString(), librairies: local.data, gestion: local.gestion });
    try {
      const res = await api('PUT', {
        message: `Suivi : mise à jour du ${new Date().toLocaleString('fr-FR')}`,
        content: b64encode(content),
        ...(local.sha ? { sha: local.sha } : {})
      });
      if ((res.status === 409 || res.status === 422) && retry) {
        // Version GitHub plus récente (autre navigateur) : on fusionne puis on renvoie
        busy = false;
        const remote = await fetchRemote();
        const m = merge(remote);
        local.data = m.merged;
        local.gestion = m.gestion;
        local.sha = remote.sha;
        writeLocal();
        return push(false);
      }
      if (!res.ok) throw new Error(explain(res));
      const json = await res.json();
      local.sha = json.content && json.content.sha;
      // Une modification faite pendant l'envoi reste à envoyer
      local.pending = snapshotOf() !== snapshot;
      local.lastSync = new Date().toISOString();
      writeLocal();
      busy = false;
      if (local.pending) schedulePush();
      else setStatus('ok', 'Tout est enregistré');
    } catch (e) {
      busy = false;
      const offline = navigator.onLine === false || e instanceof TypeError;
      setStatus(offline ? 'hors_ligne' : 'erreur', offline ? '' : e.message);
    }
  }

  function schedulePush() {
    if (suspendu) return;
    if (!isConfigured()) { setStatus('non_configure'); return; }
    setStatus('attente', '');
    // Un seul minuteur : il n'est pas relancé à chaque frappe, l'envoi part au plus tard après 2 minutes
    if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; push(); }, PUSH_MAX_DELAY_MS);
  }

  // Envoi immédiat de ce qui attend (fiche fermée, page quittée ou cachée)
  function flush() {
    if (!local.pending || !isConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = null;
    push();
  }

  // Test de la clé saisie dans l'écran « Sauvegarde »
  async function testConfig(cfg) {
    const prev = readJson(CONFIG_KEY, {});
    setConfig(cfg);
    try {
      await fetchRemote();
      return { ok: true };
    } catch (e) {
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(prev)); } catch (x) { /* rien */ }
      return { ok: false, message: e instanceof TypeError ? 'Connexion à GitHub impossible (Internet ?)' : e.message };
    }
  }

  function historyUrl() {
    const { owner, repo } = getConfig();
    return `https://github.com/${owner}/${repo}/commits/main/${FILE}`;
  }

  // Relances automatiques : retour de connexion, intervalle régulier, page de nouveau visible
  window.addEventListener('online', () => local.pending ? push() : pull());
  // Nouvel essai régulier seulement après un échec (hors ligne, erreur) : jamais d'envoi en continu
  setInterval(() => { if (local.pending && ['hors_ligne', 'erreur'].includes(status.etat)) push(); }, RETRY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    if (document.visibilityState === 'visible' && isConfigured() && !local.pending) pull().then(changed => changed && Suivi.onRemoteChange && Suivi.onRemoteChange());
  });
  window.addEventListener('beforeunload', e => {
    // Les données sont déjà dans le navigateur ; on prévient seulement si l'envoi n'a pas eu lieu
    flush();
  });
  window.addEventListener('pagehide', () => flush());
  // Un autre onglet de ce navigateur vient d'enregistrer : on reprend ses modifications et on rafraîchit l'affichage
  window.addEventListener('storage', e => {
    if (e.key !== LOCAL_KEY || suspendu) return;
    const avant = snapshotOf();
    fusionnerStockage();
    if (snapshotOf() !== avant && typeof Suivi !== 'undefined' && Suivi.onRemoteChange) Suivi.onRemoteChange();
  });

  return { all, update, collection, put, flush, suspendre, loadSnapshot, remapAliases, pull, push, onStatus, getConfig, setConfig, isConfigured, testConfig, historyUrl, onRemoteChange: null,
    pendingCount: () => (local.pending ? 1 : 0), lastSync: () => local.lastSync };
})();
