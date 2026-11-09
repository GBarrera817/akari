'use strict';
// Búsqueda unificada en sitios externos.
// Cada fuente se consulta como lo haría el usuario: se abre su página de búsqueda en una ventana
// oculta, con la misma sesión que el navegador integrado de Akari (así valen su inicio de sesión
// y sus verificaciones), y se leen los resultados que la página muestra. No se usan API privadas
// ni se evita ninguna verificación: si un sitio la pide, se avisa al usuario para que la haga él.

const { BrowserWindow } = require('electron');

const POLL_MS = 700;
const MAX_WAIT_MS = 16000;
const MAX_ITEMS = 18;
const CACHE_MS = 10 * 60 * 1000;
const LOAD_TIMEOUT_MS = 12000;
const SOURCE_TIMEOUT_MS = 35000;

// Lee los resultados de la página: agrupa los enlaces por destino y toma el mejor título e imagen.
const PAGE_LINKS = `((spec) => {
  const re = new RegExp(spec.match);
  const generic = /^(tv|ver ahora|reproducir|play|movie|película|serie|sub|dob|doblado|subtitulado)$/i;
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').replace(/^Reproducir\\s+/i, '').trim();
  const pick = (...c) => c.map(clean).find((t) => t.length >= 3 && !generic.test(t)) || '';
  const map = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!re.test(a.href)) continue;
    const key = a.href.split('#')[0].split('?')[0];
    const it = map.get(key) || { url: key, title: '', image: '', meta: '' };
    const img = a.querySelector('img');
    const firstLine = (a.innerText || '').split('\\n')[0];
    const title = pick(a.getAttribute('aria-label'), img && img.alt, a.getAttribute('title'), firstLine);
    if (title && (!it.title || title.length < it.title.length)) it.title = title;
    const src = img && (img.currentSrc || img.src);
    if (!it.image && src && /^https:/.test(src)) it.image = src;
    if (!it.meta) {
      const label = clean(firstLine);
      if (label && label.length <= 12 && generic.test(label)) it.meta = label;
    }
    map.set(key, it);
  }
  return [...map.values()].filter((it) => it.title);
})`;

// YouTube publica sus resultados como datos en la página: más fiable que leer el HTML.
const YOUTUBE_ITEMS = `(() => {
  const out = [];
  const seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        const text = (x) => (x && (x.simpleText || (x.runs || []).map((r) => r.text).join(''))) || '';
        out.push({
          url: 'https://www.youtube.com/watch?v=' + v.videoId,
          title: text(v.title),
          image: 'https://i.ytimg.com/vi/' + v.videoId + '/mqdefault.jpg',
          meta: [text(v.ownerText), text(v.lengthText)].filter(Boolean).join(' · '),
        });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(window.ytInitialData);
  return out;
})()`;

// Pluto TV solo busca al escribir en su propio buscador.
const PLUTO_TYPE = (q) => `(() => {
  const input = document.querySelector('input[type="search"]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, ${JSON.stringify(q)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`;

const SOURCES = [
  {
    id: 'crunchyroll',
    name: 'Crunchyroll',
    shape: 'poster',
    url: (q) => `https://www.crunchyroll.com/es/search?q=${encodeURIComponent(q)}`,
    host: /(^|\.)crunchyroll\.com$/,
    match: '^https://www\\.crunchyroll\\.com/[a-z-]*/?(series|watch)/',
    relevant: true,
    // La imagen pequeña viene desenfocada para el fondo; se pide la versión nítida.
    image: (src) => src.replace(/,?blur=\d+/, ''),
  },
  {
    id: 'pluto',
    name: 'Pluto TV',
    shape: 'poster',
    url: () => 'https://pluto.tv/latam/search',
    prepare: PLUTO_TYPE,
    host: /(^|\.)pluto\.tv$/,
    match: '^https://pluto\\.tv/[a-z]+/(on-demand|movies|series)/[0-9a-f]{10,}',
    relevant: true,
  },
  {
    id: 'yt-crunchyroll',
    name: 'YouTube · Crunchyroll en Español',
    shape: 'wide',
    url: (q) => `https://www.youtube.com/@CrunchyrollenEspanol/search?query=${encodeURIComponent(q)}`,
    host: /(^|\.)youtube\.com$/,
    extract: YOUTUBE_ITEMS,
  },
  {
    id: 'justwatch',
    name: 'JustWatch · dónde verlo',
    shape: 'poster',
    url: (q) => `https://www.justwatch.com/cl/buscar?q=${encodeURIComponent(q)}`,
    host: /(^|\.)justwatch\.com$/,
    match: '^https://www\\.justwatch\\.com/cl/(serie|pelicula)/',
    relevant: true,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    shape: 'wide',
    url: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    host: /(^|\.)youtube\.com$/,
    extract: YOUTUBE_ITEMS,
  },
  {
    id: 'facebook',
    name: 'Facebook',
    shape: 'wide',
    url: (q) => `https://www.facebook.com/search/videos/?q=${encodeURIComponent(q)}`,
    host: /(^|\.)facebook\.com$/,
    match: '^https://www\\.facebook\\.com/(.+/videos/|watch/?\\?v=|reel/)',
    relevant: true,
    needsLogin: true,
  },
];

const PAGE_STATE = `(() => ({
  text: (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 600) : '')).toLowerCase(),
  loginForm: !!document.querySelector('input[type="password"]'),
}))()`;

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isRelevant(title, query) {
  const words = normalize(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return true;
  const t = normalize(title);
  // Deben aparecer todas las palabras: «one piece» no debe traer «Only for One Night».
  return words.every((w) => t.includes(w));
}

function safeUrl(value, hostPattern) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return null;
    if (hostPattern && !hostPattern.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class OnlineSearch {
  constructor({ partition, onResult }) {
    this.partition = partition;
    this.onResult = onResult;
    this.current = null;
    this.cache = new Map();
  }

  sources() {
    return SOURCES.map((s) => ({ id: s.id, name: s.name, shape: s.shape, searchUrl: null }));
  }

  /** Lanza la búsqueda en todas las fuentes; cada una informa por onResult en cuanto termina. */
  search(query) {
    const q = String(query || '').trim().slice(0, 120);
    this.cancel();
    const job = { id: Date.now() + Math.random(), q, windows: new Set(), cancelled: false };
    this.current = job;
    for (const source of SOURCES) {
      const searchUrl = source.url(q);
      const emit = (data) => this.onResult({ q, source: source.id, name: source.name, shape: source.shape, searchUrl, ...data });
      const cached = this.cache.get(`${source.id}:${q.toLowerCase()}`);
      if (cached && Date.now() - cached.at < CACHE_MS) {
        emit(cached.result);
        continue;
      }
      emit({ status: 'loading', items: [] });
      // Una fuente lenta nunca deja la fila en «buscando» para siempre.
      const timeout = wait(SOURCE_TIMEOUT_MS).then(() => ({ status: 'timeout', items: [] }));
      Promise.race([this._runSource(job, source, searchUrl), timeout]).then((result) => {
        if (job.cancelled) return;
        if (result.status === 'ok' || result.status === 'empty') {
          this.cache.set(`${source.id}:${q.toLowerCase()}`, { at: Date.now(), result });
        }
        emit(result);
      });
    }
    return { q, sources: SOURCES.map((s) => ({ id: s.id, name: s.name, shape: s.shape, searchUrl: s.url(q) })) };
  }

  cancel() {
    if (!this.current) return;
    this.current.cancelled = true;
    for (const w of this.current.windows) if (!w.isDestroyed()) w.destroy();
    this.current = null;
  }

  async _runSource(job, source, searchUrl) {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 1000,
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // Sin sonido: algunas búsquedas reproducen avances automáticamente.
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    job.windows.add(win);
    try {
      // Algunas páginas nunca terminan de «cargar» (anuncios, video): se lee lo que ya muestran.
      await Promise.race([win.loadURL(searchUrl).catch(() => {}), wait(LOAD_TIMEOUT_MS)]);
      if (job.cancelled) return { status: 'cancelled', items: [] };
      if (source.prepare) {
        await wait(2500);
        await win.webContents.executeJavaScript(source.prepare(job.q)).catch(() => false);
      }
      const extract = source.extract || `${PAGE_LINKS}(${JSON.stringify({ match: source.match })})`;
      const started = Date.now();
      let items = [];
      let lastCount = -1;
      let scrolled = false;
      while (Date.now() - started < MAX_WAIT_MS && !job.cancelled) {
        await wait(POLL_MS);
        if (win.isDestroyed()) break;
        const page = await win.webContents.executeJavaScript(PAGE_STATE).catch(() => null);
        if (page && /verify you are human|security verification|just a moment|verifica que eres humano/.test(page.text)) {
          return { status: 'verify', items: [] };
        }
        items = this._clean(source, await win.webContents.executeJavaScript(extract).catch(() => []), job.q);
        if (items.length && items.length === lastCount) {
          if (scrolled) break;
          // Desplaza una vez para que carguen las imágenes diferidas.
          await win.webContents.executeJavaScript('window.scrollTo(0, 1400); true').catch(() => {});
          scrolled = true;
        }
        lastCount = items.length;
        if (!items.length && source.needsLogin && page && page.loginForm && Date.now() - started > 5000) {
          return { status: 'login', items: [] };
        }
      }
      if (job.cancelled) return { status: 'cancelled', items: [] };
      return { status: items.length ? 'ok' : 'empty', items };
    } catch (err) {
      return { status: 'error', items: [], error: String(err.message || err) };
    } finally {
      job.windows.delete(win);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  _clean(source, raw, q) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const it of raw) {
      const url = safeUrl(it && it.url, source.host);
      const title = String((it && it.title) || '').trim().slice(0, 200);
      if (!url || !title || seen.has(url)) continue;
      if (source.relevant && !isRelevant(title, q)) continue;
      seen.add(url);
      let image = safeUrl(it.image) || '';
      if (image && source.image) image = source.image(image);
      out.push({ url, title, image, meta: String(it.meta || '').slice(0, 80) });
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }
}

module.exports = { OnlineSearch, SOURCES, isRelevant };
