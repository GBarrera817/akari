'use strict';

const { app, BrowserWindow, WebContentsView, components, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable } = require('node:stream');
const { MediaCache, MediaError } = require('./media-cache');
const { DownloadManager } = require('./downloads');
const { Store } = require('./store');
const { Catalog, ID_RE, LANG_RE } = require('./catalog');
const { Subtitles } = require('./subtitles');
const { BackupManager } = require('./backup');
const { OnlineSearch } = require('./online-search');
const { MediaTracks } = require('./media-tracks');

// Permite aislar los datos en las pruebas automatizadas.
if (process.env.AKARI_USER_DATA) app.setPath('userData', process.env.AKARI_USER_DATA);

// Caché HTTP de los sitios integrados (Crunchyroll, YouTube…): 2 GB en lugar del tamaño
// automático de Chromium, para que al volver a un sitio se reutilice lo ya descargado.
// Debe fijarse antes de que arranque la app; los sitios deciden qué se puede guardar.
const WEB_CACHE_BYTES = 2 * 1024 ** 3;
app.commandLine.appendSwitch('disk-cache-size', String(WEB_CACHE_BYTES));
// Permite elegir entre las pistas de audio incluidas en un video (inglés, japonés, latino…).
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

protocol.registerSchemesAsPrivileged([{
  scheme: 'akari',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};
const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg', avi: 'video/x-msvideo' };

let win = null;
let store;
let catalog;
let cache;
let subtitles;
let downloads;
let backups;
let systemOnline = true;
let onlineSearch = null;
let mediaTracks = null;
const imageCache = new Map();

const isOffline = () => store.data.settings.offlineMode || !systemOnline;
const cacheRoot = () => store.data.settings.cacheDir || path.join(app.getPath('userData'), 'cache');
const thumbFile = (id) => path.join(cacheRoot(), 'thumbs', `${id}.jpg`);
const netFetch = (url, init) => net.fetch(url, { ...init, cache: 'no-store' });

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function extOf(file) {
  return path.extname(file).slice(1).toLowerCase() || 'mp4';
}

/** Copia completa y local del video, sin contar el respaldo. Es lo que se puede respaldar. */
function completeFile(id) {
  const ep = catalog.episode(id);
  if (!ep) return null;
  if (ep.path) {
    try {
      const stat = fs.statSync(ep.path);
      return { path: ep.path, size: stat.size, ext: extOf(ep.path) };
    } catch { /* el original ya no está: se sigue con la caché */ }
  }
  const entry = cache.get(id, ep.url || '');
  if (entry.complete) return { path: entry.dataPath, size: entry.meta.size, ext: entry.meta.ext };
  return null;
}

function statusOf(id) {
  const ep = catalog.episode(id);
  const entry = cache.get(id, ep?.url || '');
  const local = completeFile(id);
  const backup = backups.find(id);
  const size = local?.size || (entry.ready ? entry.meta.size : 0);
  const cachedBytes = local ? size : entry.cachedBytes;
  const dl = downloads.stateOf(id);
  return {
    id,
    size,
    cachedBytes,
    complete: !!local,
    isLocal: !!ep?.path,
    percent: size ? Math.min(100, Math.round((cachedBytes / size) * 100)) : 0,
    state: dl.state,
    error: dl.error || null,
    backedUp: !!backup,
    canPlayOffline: !!local || !!backup,
    canDownload: !!ep?.url,
    hasThumb: fs.existsSync(thumbFile(id)),
  };
}

function allStatus() {
  const out = {};
  for (const ep of catalog.episodes()) out[ep.id] = statusOf(ep.id);
  return out;
}

const lastSent = new Map();
function notifyStatus(id, force) {
  const now = Date.now();
  if (!force && now - (lastSent.get(id) || 0) < 400) return;
  lastSent.set(id, now);
  send('status', statusOf(id));
}

function fileStream(file, start, end) {
  return Readable.toWeb(fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 }));
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : 'invalid';
}

function rangedResponse(request, size, ext, makeBody) {
  const type = VIDEO_MIME[ext] || 'video/mp4';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  headers['Content-Length'] = String(end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(makeBody(start, end), { status: range ? 206 : 200, headers });
}

function errorResponse(status, code, message) {
  return new Response(JSON.stringify({ code, message }), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Orden de lectura: copia completa local, luego respaldo, y por último la caché por bloques,
 * que pide a la red solo lo que falte. Lo ya visto nunca vuelve a gastar red.
 */
async function serveVideo(request, id) {
  const ep = catalog.episode(id);
  if (!ep) return errorResponse(404, 'NOT_FOUND', 'Video desconocido.');
  const local = completeFile(id);
  if (local) return rangedResponse(request, local.size, local.ext, (s, e) => fileStream(local.path, s, e));
  const backup = backups.find(id);
  if (backup) return rangedResponse(request, backup.size, backup.ext, (s, e) => fileStream(backup.path, s, e));
  if (!ep.url) return errorResponse(404, 'MISSING', 'No se encuentra el archivo de este video.');
  const entry = cache.get(id, ep.url);
  try {
    await entry.prepare();
  } catch (err) {
    return errorResponse(err.code === 'OFFLINE' ? 503 : 502, err.code || 'NETWORK', err.message);
  }
  if (store.data.settings.autoCache && !isOffline() && !entry.complete && downloads.stateOf(id).state !== 'paused') {
    downloads.start(id);
  }
  subtitles.ensureAll(ep).catch(() => {});
  return rangedResponse(request, entry.meta.size, entry.meta.ext, (s, e) => entry.stream(s, e));
}

/** Archivo completo en este equipo (original, caché o respaldo) del que leer sus pistas. */
function playableFile(id) {
  return completeFile(id)?.path || backups.find(id)?.path || null;
}

async function serveSub(id, lang) {
  const ep = catalog.episode(id);
  const embedded = /^emb-(\d+)$/.exec(lang);
  if (embedded) {
    const file = await mediaTracks.subtitle(id, playableFile(id), Number(embedded[1])).catch(() => null);
    if (!file) return errorResponse(404, 'NOT_FOUND', 'No se pudo leer ese subtítulo del video.');
    return new Response(await fsp.readFile(file), { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
  }
  const sub = ep?.subs?.find((s) => s.lang === lang);
  if (!sub) return errorResponse(404, 'NOT_FOUND', 'Subtítulo desconocido.');
  const file = (await subtitles.ensure(id, sub).catch(() => null)) || backups.subtitleFile(id, lang);
  if (!file) return errorResponse(503, 'OFFLINE', 'Subtítulo no disponible sin conexión.');
  return new Response(await fsp.readFile(file), { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
}

async function serveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(RENDERER_DIR, rel);
  if (!full.startsWith(RENDERER_DIR + path.sep)) return new Response(null, { status: 403 });
  try {
    return new Response(await fsp.readFile(full), {
      headers: { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/**
 * Las miniaturas de los resultados externos pasan por aquí: la interfaz de Akari no carga nada
 * de internet directamente. Se guardan en memoria para que volver a una búsqueda sea instantáneo.
 */
async function serveRemoteImage(raw) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (target.protocol !== 'https:') return new Response(null, { status: 400 });
  const key = target.toString();
  let hit = imageCache.get(key);
  if (!hit) {
    if (isOffline()) return new Response(null, { status: 503 });
    const res = await session.fromPartition(WEB_PARTITION).fetch(key, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    const type = res && res.ok ? res.headers.get('content-type') || '' : '';
    if (!type.startsWith('image/')) return new Response(null, { status: 404 });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 5 * 1024 * 1024) return new Response(null, { status: 413 });
    hit = { type, body };
    imageCache.set(key, hit);
    if (imageCache.size > 400) imageCache.delete(imageCache.keys().next().value);
  }
  return new Response(hit.body, { headers: { 'Content-Type': hit.type, 'Cache-Control': 'max-age=3600' } });
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  if (url.host !== 'app') return new Response(null, { status: 404 });
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'media' && parts[1] === 'img') return serveRemoteImage(url.searchParams.get('u'));
  if (parts[0] === 'media') {
    const [, kind, id, lang] = parts;
    if (!id || !ID_RE.test(id)) return new Response(null, { status: 400 });
    if (kind === 'video') return serveVideo(request, id);
    if (kind === 'sub' && lang && LANG_RE.test(lang)) return serveSub(id, lang);
    if (kind === 'thumb') {
      try {
        return new Response(await fsp.readFile(thumbFile(id)), { headers: { 'Content-Type': 'image/jpeg' } });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    return new Response(null, { status: 404 });
  }
  return serveStatic(url.pathname);
}

function publicSeries(series) {
  return {
    id: series.id,
    title: series.title,
    year: series.year,
    rating: series.rating,
    genres: series.genres,
    description: series.description,
    credit: series.credit,
    featured: !!series.featured,
    art: series.art || null,
    user: !!series.user,
    episodes: series.episodes.map((e) => ({
      id: e.id,
      number: e.number,
      title: e.title,
      description: e.description,
      durationHint: e.durationHint || null,
      subs: (e.subs || []).map((s) => ({ lang: s.lang, label: s.label })),
    })),
  };
}

async function folderInfo(dir) {
  if (!dir) return null;
  try {
    const { bfree, bsize } = await fsp.statfs(dir);
    return { path: dir, freeBytes: bfree * bsize };
  } catch {
    return { path: dir, freeBytes: null, unavailable: true };
  }
}

async function pickFolder(title, defaultPath) {
  const result = await dialog.showOpenDialog(win, {
    title,
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
}

/** Traslada la caché a otra carpeta. Copia primero y borra el origen solo si todo salió bien. */
async function moveCache(target) {
  if (downloads.isBusy()) throw new Error('Pausa las descargas antes de mover la caché.');
  const source = cacheRoot();
  if (path.resolve(source) === path.resolve(target)) return;
  await cache.closeAll();
  await fsp.mkdir(target, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true }).catch(() => []);
  const ours = entries.filter((e) => e.isDirectory() ? ['subs', 'thumbs'].includes(e.name) : /\.(media|json)$/.test(e.name));
  for (const item of ours) {
    await fsp.cp(path.join(source, item.name), path.join(target, item.name), { recursive: true, force: true });
  }
  for (const item of ours) {
    await fsp.rm(path.join(source, item.name), { recursive: true, force: true });
  }
  store.data.settings.cacheDir = target;
  await store.flush();
  cache.dir = target;
  subtitles.dir = path.join(target, 'subs');
  cache.entries.clear();
  await cache.loadAll();
}

async function settingsPayload() {
  const s = store.data.settings;
  return {
    ...s,
    cacheInfo: await folderInfo(cacheRoot()),
    backupInfo: await folderInfo(s.backupDir),
    cacheBytes: cache.totalBytes(),
    online: !isOffline(),
    backup: backups.status(),
    webCacheBytes: await session.fromPartition(WEB_PARTITION).getCacheSize().catch(() => 0),
    webCacheLimit: WEB_CACHE_BYTES,
  };
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));
  const requireEpisode = (id) => {
    if (typeof id !== 'string' || !catalog.episode(id)) throw new Error('Video desconocido.');
    return id;
  };

  handle('catalog:get', () => catalog.series().map(publicSeries));
  handle('status:all', () => allStatus());
  handle('media:tracks', async (id) => {
    requireEpisode(id);
    const file = playableFile(id);
    if (!file) return { audio: [], subs: [] };
    return mediaTracks.describe(id, file).catch(() => ({ audio: [], subs: [] }));
  });
  handle('status:ranges', (id) => {
    requireEpisode(id);
    const s = statusOf(id);
    if (s.complete || s.backedUp) return [[0, 1]];
    return cache.get(id, catalog.episode(id).url || '').ranges();
  });

  handle('user:get', () => ({ progress: store.data.progress, watchlist: store.data.watchlist }));
  handle('progress:set', (id, position, duration) => {
    requireEpisode(id);
    const pos = Number(position) || 0;
    const dur = Number(duration) || 0;
    store.data.progress[id] = { position: pos, duration: dur, updatedAt: Date.now(), watched: dur > 0 && pos / dur >= 0.92 };
    store.save();
  });
  handle('progress:clear', (id) => {
    delete store.data.progress[id];
    store.save();
  });
  handle('watchlist:toggle', (seriesId) => {
    if (!catalog.seriesById(seriesId)) throw new Error('Serie desconocida.');
    const list = store.data.watchlist;
    const i = list.indexOf(seriesId);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(seriesId);
    store.save();
    return list;
  });

  handle('download:start', (id) => downloads.start(requireEpisode(id)));
  handle('download:pause', (id) => downloads.pause(requireEpisode(id)));
  handle('download:series', (seriesId) => {
    for (const ep of catalog.seriesById(seriesId)?.episodes || []) if (ep.url) downloads.start(ep.id);
  });
  handle('cache:remove', async (id) => {
    requireEpisode(id);
    await downloads.forget(id);
    await cache.remove(id);
    await subtitles.remove(id, catalog.episode(id).subs);
    notifyStatus(id, true);
  });

  handle('settings:get', settingsPayload);
  // Solo por acción del usuario: no borra la sesión iniciada, solo los archivos en caché.
  handle('webcache:clear', async () => {
    await session.fromPartition(WEB_PARTITION).clearCache();
    return settingsPayload();
  });
  handle('settings:set', async (patch) => {
    const allowed = ['autoBackup', 'autoCache', 'offlineMode', 'autoplay', 'subtitleLang'];
    for (const key of allowed) if (key in (patch || {})) store.data.settings[key] = patch[key];
    store.save();
    if (!isOffline()) downloads.resumePending();
    send('connectivity', { online: !isOffline() });
    return settingsPayload();
  });
  handle('net:online', (online) => {
    systemOnline = !!online;
    if (!isOffline()) downloads.resumePending();
    send('connectivity', { online: !isOffline() });
  });
  handle('cache:move', async () => {
    const target = await pickFolder('Nueva carpeta para la caché de videos', cacheRoot());
    if (target) await moveCache(target);
    return settingsPayload();
  });
  handle('folder:open', async (which) => {
    const dir = which === 'cache' ? cacheRoot() : store.data.settings.backupDir;
    if (dir) await shell.openPath(dir);
  });

  handle('backup:choose', async () => {
    const dir = await pickFolder('Carpeta donde guardar los respaldos', store.data.settings.backupDir);
    if (dir) {
      store.data.settings.backupDir = dir;
      store.save();
      await backups.refreshIndex();
      send('status:refresh');
    }
    return settingsPayload();
  });
  handle('backup:run', async (ids) => backups.run(Array.isArray(ids) ? ids.map(requireEpisode) : null));
  handle('backup:cancel', () => backups.cancel());
  handle('backup:import', async () => {
    const dir = await pickFolder('Carpeta con un respaldo de Akari', store.data.settings.backupDir);
    if (!dir) return null;
    const result = await backups.importFolder(dir);
    store.data.settings.backupDir = dir;
    store.save();
    await backups.refreshIndex();
    send('catalog:changed');
    return result;
  });
  handle('backup:restore', async (id) => {
    await backups.restore(requireEpisode(id));
    notifyStatus(id, true);
  });

  handle('library:importFolder', async () => {
    const dir = await pickFolder('Carpeta con tus videos');
    if (!dir) return null;
    const added = await catalog.importFolder(dir);
    send('catalog:changed');
    return { series: added.length, episodes: added.reduce((n, s) => n + s.episodes.length, 0) };
  });
  handle('library:addUrl', (input) => {
    const ep = catalog.addUrl(input || {});
    send('catalog:changed');
    return ep.id;
  });
  handle('library:removeSeries', (id) => {
    catalog.removeUserSeries(id);
    store.data.watchlist = store.data.watchlist.filter((s) => s !== id);
    store.save();
    send('catalog:changed');
  });

  handle('search:online', (q) => {
    if (isOffline()) throw new Error('Sin conexión: solo se busca en tu catálogo.');
    return onlineSearch.search(String(q || ''));
  });
  handle('search:cancel', () => onlineSearch.cancel());
  handle('web:show', (url, bounds) => webShow(String(url || ''), bounds));
  handle('web:bounds', (bounds) => webSetBounds(bounds));
  handle('web:hide', () => webHide());
  handle('web:nav', (action) => webNav(String(action)));

  handle('thumb:save', async (id, dataUrl) => {
    requireEpisode(id);
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error('Miniatura no válida.');
    const file = thumbFile(id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from(m[1], 'base64'));
  });
}

/* ---------- Navegador integrado ----------
 * Los sitios externos (Crunchyroll, YouTube, Pluto TV…) se muestran dentro de la ventana
 * principal de Akari, en una vista aislada: sin acceso a Akari ni a los archivos del equipo.
 * Los inicios de sesión y las ventanas emergentes se abren en esa misma vista, de modo que
 * al terminar de iniciar sesión el sitio vuelve solo a su página, siempre dentro de Akari.
 * La sesión queda guardada en disco; Akari no ve ni guarda contraseñas.
 * Lo que se reproduce aquí (con DRM o no) no pasa por la caché ni los respaldos.
 */
const WEB_PARTITION = 'persist:web';
let webView = null;
let webVisible = false;
let webFull = false;
let webRequested = null;
let webError = null;
let widevineReady = null;

function isWebUrl(url) {
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function ensureWidevine() {
  // El módulo se descarga la primera vez; si falla (por ejemplo sin red) se reintenta la próxima vez.
  if (!widevineReady) {
    widevineReady = components.whenReady().catch((err) => {
      widevineReady = null;
      throw new Error(`No se pudo preparar el módulo de video protegido (Widevine). Revisa tu conexión. ${err.message || ''}`.trim());
    });
  }
  return widevineReady;
}

function setupWebSession() {
  const webSession = session.fromPartition(WEB_PARTITION);
  // Algunos sitios rechazan navegadores que se anuncian como Electron.
  webSession.setUserAgent(webSession.getUserAgent().replace(/\s(akari|Akari|Electron)\/\S+/g, ''));
  const allowed = new Set(['mediaKeySystem', 'fullscreen', 'clipboard-sanitized-write']);
  webSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  webSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function webState() {
  if (!webView) return null;
  const wc = webView.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
    error: webError,
  };
}

const pushWebState = () => send('web:state', webState());

function layoutWebFull() {
  const [width, height] = win.getContentSize();
  webView.setBounds({ x: 0, y: 0, width, height });
}

function setWebFullscreen(on) {
  webFull = on;
  win.setFullScreen(on);
  send('web:fullscreen', on);
  if (on) layoutWebFull();
}

function createWebView() {
  webView = new WebContentsView({
    webPreferences: { partition: WEB_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  webView.setBackgroundColor('#000000');
  const wc = webView.webContents;
  // Enlaces en pestaña nueva e inicios de sesión emergentes: se abren en la misma vista.
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) webError = null;
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3 es una carga cancelada por otra navegación: no es un error real.
    if (isMainFrame && code !== -3) {
      webError = { code, description, url };
      pushWebState();
    }
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    wc.on(ev, pushWebState);
  }
  wc.on('enter-html-full-screen', () => setWebFullscreen(true));
  wc.on('leave-html-full-screen', () => setWebFullscreen(false));
}

function webSetBounds(bounds) {
  if (!webView || webFull || !bounds) return;
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  webView.setBounds({ x: n(bounds.x), y: n(bounds.y), width: n(bounds.width), height: n(bounds.height) });
}

async function webShow(url, bounds) {
  if (!isWebUrl(url)) throw new Error('Dirección no válida.');
  if (isOffline()) throw new Error('Necesitas conexión a internet para ver este sitio.');
  try {
    await ensureWidevine();
  } catch (err) {
    // Sin Widevine los sitios gratuitos igual funcionan; Crunchyroll no.
    if (/(^|\.)crunchyroll\.com$/i.test(new URL(url).hostname)) throw err;
  }
  if (!webView) createWebView();
  if (!webVisible) {
    win.contentView.addChildView(webView);
    webVisible = true;
  }
  webSetBounds(bounds);
  // Volver a la misma búsqueda conserva la página donde quedó el usuario.
  if (webRequested !== url) {
    webRequested = url;
    webError = null;
    webView.webContents.loadURL(url).catch(() => {});
  }
  pushWebState();
}

async function webHide() {
  if (!webView || !webVisible) return;
  if (webFull) setWebFullscreen(false);
  // Al salir de la vista se pausa lo que esté sonando.
  await webView.webContents
    .executeJavaScript("document.querySelectorAll('video,audio').forEach((m) => m.pause())", true)
    .catch(() => {});
  win.contentView.removeChildView(webView);
  webVisible = false;
}

function webNav(action) {
  if (!webView) return;
  const wc = webView.webContents;
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') {
    webError = null;
    if (wc.getURL().startsWith('chrome-error:') && webRequested) wc.loadURL(webRequested).catch(() => {});
    else wc.reload();
  } else if (action === 'external' && isWebUrl(wc.getURL())) shell.openExternal(wc.getURL());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Akari',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenu(null);
  // La interfaz nunca navega fuera de la app; los enlaces externos van al navegador.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('akari://app/')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('resize', () => {
    if (webFull && webView) layoutWebFull();
  });
  win.loadURL('akari://app/index.html');
}

async function bootstrap() {
  store = new Store(path.join(app.getPath('userData'), 'datos.json'));
  catalog = new Catalog(store);
  cache = new MediaCache({ dir: cacheRoot(), fetchImpl: netFetch, isOffline });
  subtitles = new Subtitles({ dir: path.join(cacheRoot(), 'subs'), fetchImpl: netFetch, isOffline });
  downloads = new DownloadManager({
    cache,
    resolveUrl: (id) => catalog.episode(id)?.url || null,
    persisted: store.data.downloads,
    onChange: () => store.save(),
  });
  backups = new BackupManager({
    getFolder: () => store.data.settings.backupDir,
    completeFile,
    getUserData: () => ({ progress: store.data.progress, watchlist: store.data.watchlist }),
    applyUserData: (data) => {
      for (const [id, p] of Object.entries(data.progress || {})) {
        if (!ID_RE.test(id) || !p || typeof p !== 'object') continue;
        const mine = store.data.progress[id];
        if (!mine || (p.updatedAt || 0) > (mine.updatedAt || 0)) store.data.progress[id] = p;
      }
      for (const s of Array.isArray(data.watchlist) ? data.watchlist : []) {
        if (typeof s === 'string' && !store.data.watchlist.includes(s)) store.data.watchlist.push(s);
      }
      store.save();
    },
    cache,
    subtitles,
    catalog,
  });

  await cache.loadAll();
  await backups.refreshIndex();

  cache.on('progress', (entry) => notifyStatus(entry.id));
  cache.on('complete', (entry) => {
    notifyStatus(entry.id, true);
    const ep = catalog.episode(entry.id);
    if (ep) subtitles.ensureAll(ep).catch(() => {});
    // Si el video se completó viéndolo, también debe figurar como descargado.
    const dl = downloads.stateOf(entry.id).state;
    if (!downloads.active.has(entry.id) && dl !== 'done') {
      downloads.states[entry.id] = { state: 'done' };
      store.save();
      autoBackup(entry.id);
    }
  });
  downloads.on('state', (id) => notifyStatus(id, true));
  downloads.on('done', autoBackup);
  backups.on('progress', () => {
    send('backup:progress', backups.status());
  });

  function autoBackup(id) {
    const s = store.data.settings;
    if (s.autoBackup && s.backupDir) {
      backups.run([id]).then(() => notifyStatus(id, true)).catch(() => {});
    }
  }

  protocol.handle('akari', (request) => handleProtocol(request).catch((err) => {
    const known = err instanceof MediaError;
    return errorResponse(500, known ? err.code : 'INTERNAL', err.message);
  }));
  registerIpc();
  setupWebSession();
  mediaTracks = new MediaTracks({ subsDir: () => subtitles.dir });
  onlineSearch = new OnlineSearch({ partition: WEB_PARTITION, onResult: (r) => send('search:source', r) });
  createWindow();
  // Prepara Widevine en segundo plano; Akari no lo necesita para su propio contenido.
  if (!isOffline()) ensureWidevine().catch(() => {});
  downloads.resumePending();
}

const gotLock = process.env.AKARI_USER_DATA ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(bootstrap);
  app.on('window-all-closed', () => app.quit());

  let finishing = false;
  app.on('before-quit', (event) => {
    if (finishing || !store) return;
    event.preventDefault();
    finishing = true;
    // Guarda el mapa de bloques: una descarga a medias sigue donde quedó en el próximo arranque.
    downloads.stopAll()
      .then(() => Promise.all([cache.closeAll(), store.flush()]))
      .finally(() => app.exit(0));
  });
}
