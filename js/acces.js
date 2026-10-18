/**
 * BIBLIO-PROSPECT — Accès aux données
 *
 * Le dossier de l'outil ne contient AUCUNE donnée. Avec la clé d'accès (la même que pour la sauvegarde),
 * l'outil télécharge les données depuis le dépôt GitHub PRIVÉ (fichier compressé, ≈ 0,4 Mo).
 * Quand le navigateur le permet, une copie est gardée : démarrage plus rapide, et fonctionnement
 * sans Internet avec les données de la dernière visite.
 */
const Acces = (() => {
  const DATA_PATH = 'data/librairies.json.gz';
  const SHA_KEY = 'biblio_donnees_sha';
  const CACHE_NAME = 'biblio-donnees';
  const localMode = new URLSearchParams(location.search).get('donnees') === 'local'; // aperçu de développement

  const FETCH_TIMEOUT_MS = 20000;

  // Copie locale des données dans IndexedDB (fonctionne aussi quand l'outil est ouvert depuis un fichier,
  // contrairement au « Cache » du navigateur). Si le navigateur la refuse : téléchargement à chaque ouverture.
  function idb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB indisponible'));
      const req = indexedDB.open(CACHE_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('donnees');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function cacheGet(sha) {
    try {
      if (!sha) return null;
      const db = await idb();
      return await new Promise(resolve => {
        const req = db.transaction('donnees').objectStore('donnees').get('courant');
        req.onsuccess = () => resolve(req.result && req.result.sha === sha ? req.result.text : null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function cachePut(sha, text) {
    try {
      const db = await idb();
      await new Promise(resolve => {
        const tx = db.transaction('donnees', 'readwrite');
        tx.objectStore('donnees').put({ sha, text }, 'courant'); // une seule version gardée
        tx.oncomplete = tx.onerror = () => resolve();
      });
      localStorage.setItem(SHA_KEY, sha);
    } catch (e) { /* stockage refusé par le navigateur : sans gravité */ }
  }

  // Requête avec délai maximal : sur une connexion instable, mieux vaut réessayer vite qu'attendre
  async function fetchTimeout(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Ce navigateur est trop ancien pour lire les données : mettez à jour Safari, Chrome, Edge ou Firefox.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  const b64ToBytes = b64 => Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0));

  function explain(status) {
    if (status === 401) return "Clé d'accès invalide ou expirée.";
    if (status === 403) return "Cette clé d'accès n'a pas le droit de lire les données.";
    if (status === 404) return "Données introuvables : vérifiez que la clé donne bien accès au dépôt « biblio-prospect-donnees ».";
    return `Erreur GitHub ${status}`;
  }

  // Connexion instable : jusqu'à 3 tentatives espacées avant d'abandonner (sauf clé refusée)
  async function load() {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await loadOnce();
      } catch (e) {
        if (e.cle) throw e;
        lastError = e;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
    throw lastError;
  }

  /** @returns {Promise<{data: object, horsLigne: boolean}>} */
  async function loadOnce() {
    if (localMode) {
      const res = await fetch('data/librairies.json', { cache: 'no-store' });
      return { data: await res.json(), horsLigne: false };
    }
    const { owner, repo, token } = Suivi.getConfig();
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

    // 1. Empreinte (sha) du fichier, via la liste du dossier « data » : quelques octets seulement
    let sha;
    try {
      const res = await fetchTimeout(`${base}/contents/data?t=${Date.now()}`, { headers, cache: 'no-store' });
      if (!res.ok) {
        const err = new Error(explain(res.status));
        err.cle = [401, 403, 404].includes(res.status);
        throw err;
      }
      const entry = (await res.json()).find(f => f.path === DATA_PATH);
      if (!entry) throw Object.assign(new Error(explain(404)), { cle: true });
      sha = entry.sha;
    } catch (e) {
      if (e.cle) throw e;
      // Pas d'Internet : données de la dernière visite, si le navigateur a pu les garder
      const text = await cacheGet(localStorage.getItem(SHA_KEY));
      if (text) return { data: JSON.parse(text), horsLigne: true };
      throw new Error('Connexion à GitHub impossible. Vérifiez la connexion Internet puis réessayez.');
    }

    // 2. Données inchangées depuis la dernière visite : copie locale, rien à télécharger
    const cached = await cacheGet(sha);
    if (cached) return { data: JSON.parse(cached), horsLigne: false };

    // 3. Sinon, téléchargement du fichier compressé (API « blobs » : fonctionne quelle que soit la taille)
    const blob = await fetchTimeout(`${base}/git/blobs/${sha}`, { headers, cache: 'no-store' });
    if (!blob.ok) throw new Error(explain(blob.status));
    const text = await gunzip(b64ToBytes((await blob.json()).content));
    const data = JSON.parse(text);
    await cachePut(sha, text);
    return { data, horsLigne: false };
  }

  return { load, localMode };
})();
