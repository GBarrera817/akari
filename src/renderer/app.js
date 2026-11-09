import { openPlayer, closePlayer, isPlayerOpen } from './player.js';

const api = window.akari;
const view = document.getElementById('view');

export const state = {
  series: [],
  status: {},
  user: { progress: {}, watchlist: [] },
  settings: null,
  online: true,
  backup: null,
};

const icons = {
  play: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 4l14 8-14 8z"/></svg>',
  playBig: '<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true"><path fill="#fff" d="M7 4l14 8-14 8z"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 3h2v10l4-4 1.400 1.400L12 16.800 5.600 10.400 7 9l4 4zM4 19h16v2H4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.500 17.500 4 12l1.400-1.400 4.100 4.100 9.100-9.100L20 7z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg>',
};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function toast(message, isError) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 4000);
}

function confirmDialog(title, text, okLabel) {
  const dlg = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-ok').textContent = okLabel;
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return undefined;
  }
}

/* ---------- Consultas sobre el catálogo ---------- */

export function findEpisode(id) {
  for (const series of state.series) {
    const index = series.episodes.findIndex((e) => e.id === id);
    if (index >= 0) return { ...series.episodes[index], series, index };
  }
  return null;
}

const allEpisodes = () => state.series.flatMap((s) => s.episodes.map((e) => ({ ...e, series: s })));

function canPlayNow(id) {
  return state.online || !!state.status[id]?.canPlayOffline || (state.status[id]?.cachedBytes > 0);
}

function seriesAvailable(series) {
  return series.episodes.some((e) => canPlayNow(e.id));
}

function nextUp(series) {
  const eps = series.episodes;
  const inProgress = eps.find((e) => {
    const p = state.user.progress[e.id];
    return p && !p.watched && p.position > 5;
  });
  if (inProgress) return inProgress;
  return eps.find((e) => !state.user.progress[e.id]?.watched) || eps[0];
}

/* ---------- Piezas de interfaz ---------- */

function gradientFor(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `--a:hsl(${h} 55% 28%);--b:hsl(${(h + 60) % 360} 65% 42%)`;
}

function artImg(series, kind, cls = '') {
  const fallback = `<span class="art-fallback" style="${gradientFor(series.title)}">${esc(series.title)}</span>`;
  if (series.art) return `${fallback}<img class="${cls}" src="art/${esc(series.art)}-${kind}.jpg" alt="" loading="lazy" data-hide-on-error>`;
  const first = series.episodes[0];
  return first ? `${fallback}<img class="${cls}" src="media/thumb/${esc(first.id)}" alt="" loading="lazy" data-hide-on-error>` : fallback;
}

function epImg(ep) {
  const series = ep.series;
  const fallback = `<span class="art-fallback" style="${gradientFor(ep.title)}">${esc(ep.number)}</span>`;
  const src = series.art ? `art/${esc(ep.id)}.jpg` : `media/thumb/${esc(ep.id)}`;
  return `${fallback}<img src="${src}" alt="" loading="lazy" data-hide-on-error>`;
}

function posterCard(series) {
  const dim = !state.online && !seriesAvailable(series) ? ' unavailable' : '';
  const count = series.episodes.length;
  return `<a class="poster-card${dim}" href="#/serie/${esc(series.id)}" data-series-card="${esc(series.id)}">
    <span class="poster-frame">${artImg(series, 'poster')}
      <span class="poster-hover">
        <b>${esc(series.title)}</b>
        <span class="clamp">${esc(series.description)}</span>
        <span class="go">Ver detalles</span>
      </span>
    </span>
    <span class="poster-title">${esc(series.title)}</span>
    <span class="poster-meta">${count} ${count === 1 ? 'video' : 'videos'}${series.year ? ` · ${esc(series.year)}` : ''}</span>
  </a>`;
}

function statusBadge(id) {
  const s = state.status[id];
  if (!s) return '';
  if (s.state === 'error') return `<span class="badge err" title="${esc(s.error)}">Error de descarga</span>`;
  if (s.complete && s.isLocal) return `<span class="badge ok">${icons.check} En tu equipo${s.backedUp ? ' · respaldado' : ''}</span>`;
  if (s.complete) return `<span class="badge ok">${icons.check} Disponible sin conexión${s.backedUp ? ' · respaldado' : ''}</span>`;
  if (s.backedUp) return `<span class="badge ok">${icons.check} En el respaldo</span>`;
  if (s.state === 'downloading' || s.state === 'queued') return `<span class="badge warn">Guardando ${s.percent}%</span>`;
  if (s.state === 'waiting') return `<span class="badge warn">Esperando conexión · ${s.percent}%</span>`;
  if (s.cachedBytes > 0) return `<span class="badge">Guardado ${s.percent}%</span>`;
  return '';
}

function progressBar(id) {
  const p = state.user.progress[id];
  if (!p || !p.duration) return '';
  const pct = p.watched ? 100 : Math.min(100, (p.position / p.duration) * 100);
  return `<span class="ep-bar"><i style="width:${pct.toFixed(1)}%"></i></span>`;
}

function durationOf(ep) {
  const p = state.user.progress[ep.id];
  return p?.duration || ep.durationHint || 0;
}

function episodeCard(ep, withSeries = true) {
  const dim = canPlayNow(ep.id) ? '' : ' unavailable';
  const dur = durationOf(ep);
  return `<a class="ep-card${dim}" href="#/ver/${esc(ep.id)}">
    <span class="ep-thumb">${epImg(ep)}
      <span class="ep-play">${icons.playBig}</span>
      ${dur ? `<span class="ep-duration">${fmtTime(dur)}</span>` : ''}
      ${progressBar(ep.id)}
    </span>
    ${withSeries ? `<span class="ep-series">${esc(ep.series.title)}</span>` : ''}
    <span class="ep-title">${esc(ep.title)}</span>
    <span data-badge="${esc(ep.id)}">${statusBadge(ep.id)}</span>
  </a>`;
}

function downloadButton(id, compact) {
  const s = state.status[id];
  if (!s) return '';
  const small = compact ? ' small' : '';
  if (s.complete || !s.canDownload) return '';
  if (s.state === 'downloading' || s.state === 'queued') {
    return `<button class="btn quiet${small}" data-act="pause" data-id="${esc(id)}">Pausar · ${s.percent}%</button>`;
  }
  const label = s.state === 'paused' || s.state === 'waiting' || s.cachedBytes > 0 ? `Continuar · ${s.percent}%` : 'Descargar';
  const disabled = state.online ? '' : ' disabled title="Necesitas conexión para descargar"';
  return `<button class="btn ghost${small}" data-act="download" data-id="${esc(id)}"${disabled}>${icons.down} ${label}</button>`;
}

function offlineBanner() {
  return state.online ? '' : '<div class="offline-banner">Estás sin conexión. Puedes ver todo lo guardado; lo que no esté disponible aparece en gris.</div>';
}

/* ---------- Vistas ---------- */

let heroTimer = null;

function viewHome() {
  const featured = state.series.filter((s) => s.featured);
  const continuing = Object.entries(state.user.progress)
    .filter(([, p]) => !p.watched && p.position > 5)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([id]) => findEpisode(id))
    .filter(Boolean);
  const saved = allEpisodes().filter((e) => state.status[e.id]?.canPlayOffline);
  const library = state.series.filter((s) => s.user);
  const genres = [...new Set(state.series.filter((s) => !s.user).flatMap((s) => s.genres))].slice(0, 3);

  const rows = [];
  if (continuing.length) rows.push(row('Continuar viendo', `<div class="grid-episodes">${continuing.map((e) => episodeCard(e)).join('')}</div>`));
  if (saved.length) rows.push(row('Disponible sin conexión', `<div class="grid-episodes">${saved.slice(0, 8).map((e) => episodeCard(e)).join('')}</div>`));
  if (library.length) rows.push(row('Mi biblioteca', `<div class="grid-posters">${library.map(posterCard).join('')}</div>`));
  rows.push(row('Todo el catálogo', `<div class="grid-posters">${state.series.filter((s) => !s.user).map(posterCard).join('')}</div>`));
  for (const g of genres) {
    const list = state.series.filter((s) => s.genres.includes(g));
    if (list.length > 1) rows.push(row(g, `<div class="grid-posters">${list.map(posterCard).join('')}</div>`));
  }

  view.innerHTML = `${offlineBanner()}${featured.length ? '<section class="hero" id="hero"></section>' : ''}<div class="page">${rows.join('')}</div>`;
  if (featured.length) startHero(featured);
}

function row(title, inner) {
  return `<section class="row"><h2 class="row-title">${esc(title)}</h2>${inner}</section>`;
}

function startHero(featured) {
  const hero = document.getElementById('hero');
  let index = 0;
  const paint = () => {
    const series = featured[index];
    const ep = nextUp(series);
    const started = state.user.progress[ep.id]?.position > 5;
    hero.innerHTML = `
      <img class="hero-img" src="art/${esc(series.art)}-banner.jpg" alt="" data-hide-on-error>
      <div class="hero-body">
        <h1>${esc(series.title)}</h1>
        <div class="meta">${series.rating ? `<span class="rating">${esc(series.rating)}</span>` : ''}<span>${esc(series.genres.join(', '))}</span></div>
        <p class="desc">${esc(series.description)}</p>
        <div class="hero-actions">
          <a class="btn primary" href="#/ver/${esc(ep.id)}">${icons.play} ${started ? 'Continuar' : 'Ver ahora'}</a>
          <a class="btn ghost" href="#/serie/${esc(series.id)}">Detalles</a>
        </div>
      </div>
      <div class="hero-dots">${featured.map((s, i) => `<button class="${i === index ? 'on' : ''}" data-hero="${i}" aria-label="Destacado ${i + 1}: ${esc(s.title)}"></button>`).join('')}</div>`;
  };
  paint();
  clearInterval(heroTimer);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && featured.length > 1) {
    heroTimer = setInterval(() => {
      index = (index + 1) % featured.length;
      paint();
    }, 9000);
  }
  hero.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hero]');
    if (b) {
      index = Number(b.dataset.hero);
      paint();
    }
  });
}

function viewBrowse() {
  const genres = [...new Set(state.series.flatMap((s) => s.genres))].sort((a, b) => a.localeCompare(b, 'es'));
  const selected = decodeURIComponent(location.hash.split('?g=')[1] || '');
  const list = [...state.series]
    .filter((s) => !selected || s.genres.includes(selected))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
  view.innerHTML = `${offlineBanner()}<div class="page">
    <h1 class="page-title">Explorar</h1>
    <div class="set-actions" style="justify-content:flex-start;margin:14px 0 24px">
      <a class="btn small ${selected ? 'quiet' : 'primary'}" href="#/explorar">Todo</a>
      ${genres.map((g) => `<a class="btn small ${g === selected ? 'primary' : 'quiet'}" href="#/explorar?g=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}
    </div>
    <div class="grid-posters">${list.map(posterCard).join('')}</div>
  </div>`;
}

/* ---------- Búsqueda unificada ----------
 * Se busca a la vez en tu catálogo y en todas las fuentes externas; cada fuente aparece
 * en cuanto responde. Al abrir un resultado, se ve dentro de Akari.
 */
const online = { q: null, order: [], results: {} };
let onlineTimer = null;

function startOnlineSearch(q) {
  if (online.q === q) return;
  online.q = q;
  online.order = [];
  online.results = {};
  clearTimeout(onlineTimer);
  if (!state.online || q.length < 2) return;
  // Espera a que termines de escribir para no buscar letra por letra.
  onlineTimer = setTimeout(() => {
    if (online.q === q) guarded(() => api.searchOnline(q));
  }, 650);
}

api.onSearchSource((r) => {
  if (r.q !== online.q) return;
  if (!online.order.includes(r.source)) online.order.push(r.source);
  online.results[r.source] = r;
  paintOnline();
});

const shortName = (name) => name.split(' · ')[0];

function onlineCard(src, it) {
  const img = it.image ? `<img src="media/img?u=${encodeURIComponent(it.image)}" alt="" loading="lazy" data-hide-on-error>` : '';
  const href = esc(webHref(shortName(src.name), it.url));
  const fallback = `<span class="art-fallback" style="${gradientFor(it.title)}">${esc(it.title)}</span>`;
  if (src.shape === 'poster') {
    return `<a class="poster-card" href="${href}">
      <span class="poster-frame">${fallback}${img}</span>
      <span class="poster-title" title="${esc(it.title)}">${esc(it.title)}</span>
      <span class="poster-meta">${esc(it.meta || shortName(src.name))}</span>
    </a>`;
  }
  return `<a class="ep-card" href="${href}">
    <span class="ep-thumb">${fallback}${img}<span class="ep-play">${icons.playBig}</span></span>
    <span class="ep-title clamp-2" title="${esc(it.title)}">${esc(it.title)}</span>
    ${it.meta ? `<span class="ep-series" style="text-transform:none">${esc(it.meta)}</span>` : ''}
  </a>`;
}

function onlineSection(src) {
  const open = esc(webHref(shortName(src.name), src.searchUrl));
  const more = `<a class="row-more" href="${open}">Ver en ${esc(shortName(src.name))} ›</a>`;
  const head = (extra = '') => `<div class="row-head"><h2 class="row-title">${esc(src.name)}${extra}</h2>${more}</div>`;
  const grid = src.shape === 'poster' ? 'grid-posters' : 'grid-episodes';
  if (src.status === 'loading') {
    const skel = Array.from({ length: src.shape === 'poster' ? 6 : 4 }, () => `<span class="skeleton ${src.shape}"></span>`).join('');
    return `<section class="row" data-source="${esc(src.source)}">${head(' <span class="row-count">buscando…</span>')}<div class="${grid}">${skel}</div></section>`;
  }
  if (src.status === 'verify') {
    return `<section class="row" data-source="${esc(src.source)}">${head()}<p class="online-note">${esc(shortName(src.name))} pide verificar que eres humano antes de mostrar resultados. <a href="${open}">Ábrelo, marca la casilla</a> y vuelve a buscar: la verificación queda guardada.</p></section>`;
  }
  if (src.status === 'login') {
    return `<section class="row" data-source="${esc(src.source)}">${head()}<p class="online-note">${esc(shortName(src.name))} solo muestra resultados con la sesión iniciada. <a href="${open}">Inicia sesión aquí</a> y vuelve a buscar.</p></section>`;
  }
  return `<section class="row" data-source="${esc(src.source)}">${head(` <span class="row-count">${src.items.length}</span>`)}<div class="${grid}">${src.items.slice(0, src.shape === 'poster' ? 12 : 8).map((it) => onlineCard(src, it)).join('')}</div></section>`;
}

function paintOnline() {
  const box = document.getElementById('online-results');
  if (!box) return;
  if (!state.online) {
    box.innerHTML = '<p class="online-note">Sin conexión: solo se muestra lo que hay en tu catálogo.</p>';
    return;
  }
  const list = online.order.map((id) => online.results[id]);
  const shown = list.filter((r) => ['loading', 'ok', 'verify', 'login'].includes(r.status));
  const none = list.filter((r) => r.status === 'empty');
  const failed = list.filter((r) => ['error', 'timeout'].includes(r.status));
  const waiting = !list.length && online.q && online.q.length >= 2;
  box.innerHTML = `${shown.map(onlineSection).join('')}
    ${none.length ? `<p class="online-note">Sin resultados en ${none.map((r) => esc(shortName(r.name))).join(', ')}.</p>` : ''}
    ${failed.length ? `<p class="online-note">No respondieron a tiempo: ${failed.map((r) => `<a href="${esc(webHref(shortName(r.name), r.searchUrl))}">${esc(shortName(r.name))}</a>`).join(', ')}. Puedes abrirlos directamente.</p>` : ''}
    ${waiting ? '<p class="online-note">Buscando en Crunchyroll, Pluto TV, YouTube, JustWatch y Facebook…</p>' : ''}`;
}

function viewSearch(q) {
  q = q.trim().slice(0, 120);
  const needle = q.toLowerCase();
  const matches = state.series.filter((s) => s.title.toLowerCase().includes(needle)
    || s.genres.some((g) => g.toLowerCase().includes(needle))
    || s.episodes.some((e) => e.title.toLowerCase().includes(needle)));
  view.innerHTML = `<div class="page">
    <h1 class="page-title">Resultados para «${esc(q)}»</h1>
    <p class="page-sub">Toca cualquier resultado para verlo aquí mismo, dentro de Akari. Lo que veas en sitios externos no se guarda para verlo sin conexión.</p>
    ${matches.length ? `<section class="row"><div class="row-head"><h2 class="row-title">En tu biblioteca <span class="row-count">${matches.length}</span></h2></div><div class="grid-posters">${matches.map(posterCard).join('')}</div></section>` : ''}
    <div id="online-results"></div>
  </div>`;
  startOnlineSearch(q);
  paintOnline();
}

function viewSeries(id) {
  const series = state.series.find((s) => s.id === id);
  if (!series) {
    view.innerHTML = '<div class="empty"><h2>Serie no encontrada</h2></div>';
    return;
  }
  const inList = state.user.watchlist.includes(id);
  const ep = nextUp(series);
  const started = state.user.progress[ep.id]?.position > 5;
  const hasRemote = series.episodes.some((e) => state.status[e.id]?.canDownload && !state.status[e.id]?.complete);
  view.innerHTML = `${offlineBanner()}<section class="series-hero">
      ${series.art ? `<img class="bg" src="art/${esc(series.art)}-banner.jpg" alt="" data-hide-on-error>` : `<img class="bg" src="media/thumb/${esc(series.episodes[0]?.id)}" alt="" data-hide-on-error>`}
      <div class="series-body">
        <h1>${esc(series.title)}</h1>
        <div class="meta">${series.rating ? `<span class="rating">${esc(series.rating)}</span>` : ''}${series.year ? `<span>${esc(series.year)}</span>` : ''}<span>${esc(series.genres.join(', '))}</span></div>
        <p>${esc(series.description)}</p>
        <div class="series-actions">
          <a class="btn primary" href="#/ver/${esc(ep.id)}">${icons.play} ${started ? 'Continuar' : 'Empezar a ver'}</a>
          <button class="btn ghost" data-act="watchlist" data-id="${esc(id)}">${inList ? `${icons.check} En mi lista` : `${icons.plus} Agregar a mi lista`}</button>
          ${hasRemote ? `<button class="btn ghost" data-act="download-series" data-id="${esc(id)}" ${state.online ? '' : 'disabled'}>${icons.down} Descargar todo</button>` : ''}
          ${series.user ? `<button class="btn danger" data-act="remove-series" data-id="${esc(id)}">Quitar de la biblioteca</button>` : ''}
        </div>
        ${series.credit ? `<p class="credit">${esc(series.credit)}</p>` : ''}
      </div>
    </section>
    <div class="page">
      <h2 class="row-title">Episodios y videos</h2>
      <div class="ep-list">${series.episodes.map((e) => episodeRow({ ...e, series })).join('')}</div>
    </div>`;
}

function episodeRow(ep) {
  const dim = canPlayNow(ep.id) ? '' : ' unavailable';
  const dur = durationOf(ep);
  return `<article class="ep-row${dim}" data-ep-row="${esc(ep.id)}">
    <a class="ep-card" href="#/ver/${esc(ep.id)}" aria-label="Ver ${esc(ep.title)}">
      <span class="ep-thumb">${epImg(ep)}
        <span class="ep-play">${icons.playBig}</span>
        ${dur ? `<span class="ep-duration">${fmtTime(dur)}</span>` : ''}
        ${progressBar(ep.id)}
      </span>
    </a>
    <div>
      <h3>${esc(ep.number)}. ${esc(ep.title)}</h3>
      ${ep.description ? `<p>${esc(ep.description)}</p>` : ''}
      <span data-badge="${esc(ep.id)}">${statusBadge(ep.id)}</span>
    </div>
    <div class="ep-actions" data-actions="${esc(ep.id)}">${downloadButton(ep.id, true)}</div>
  </article>`;
}

function viewLists() {
  const list = state.user.watchlist.map((id) => state.series.find((s) => s.id === id)).filter(Boolean);
  view.innerHTML = `<div class="page">
    <h1 class="page-title">Mi lista</h1>
    ${list.length ? `<div class="grid-posters" style="margin-top:20px">${list.map(posterCard).join('')}</div>` : '<div class="empty"><h2>Tu lista está vacía</h2><p>Agrega series desde su página para encontrarlas rápido.</p><a class="btn primary" href="#/explorar">Explorar</a></div>'}
  </div>`;
}

function viewHistory() {
  const items = Object.entries(state.user.progress)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([id]) => findEpisode(id))
    .filter(Boolean);
  view.innerHTML = `<div class="page">
    <h1 class="page-title">Historial</h1>
    ${items.length ? `<div class="grid-episodes" style="margin-top:20px">${items.map((e) => episodeCard(e)).join('')}</div>` : '<div class="empty"><h2>Aún no has visto nada</h2><a class="btn primary" href="#/">Ir al inicio</a></div>'}
  </div>`;
}

function backupProgressHtml() {
  const run = state.backup?.running;
  if (!run) return '';
  const pct = run.bytesTotal ? Math.round((run.bytes / run.bytesTotal) * 100) : 0;
  return `<div class="backup-progress" id="backup-progress">
    <b>Respaldando ${run.done + 1} de ${run.total}:</b> ${esc(run.currentTitle)}
    <div class="progress"><i style="width:${pct}%"></i></div>
    <button class="btn quiet small" data-act="backup-cancel">Cancelar respaldo</button>
  </div>`;
}

function viewDownloads() {
  const items = allEpisodes().filter((e) => {
    const s = state.status[e.id];
    return s && (s.cachedBytes > 0 || s.backedUp || !['idle'].includes(s.state));
  });
  const totalCached = items.filter((e) => !state.status[e.id].isLocal).reduce((n, e) => n + state.status[e.id].cachedBytes, 0);
  const offlineCount = items.filter((e) => state.status[e.id].canPlayOffline).length;
  const backedUp = items.filter((e) => state.status[e.id].backedUp).length;
  const s = state.settings;
  view.innerHTML = `<div class="page">
    <h1 class="page-title">Descargas</h1>
    <p class="page-sub">Todo lo que reproduces queda guardado en tu equipo y se abre al instante la próxima vez. Akari nunca borra estos archivos por su cuenta.</p>
    <div class="dl-summary">
      <div><b>${fmtBytes(totalCached)}</b><span>en caché</span></div>
      <div><b>${offlineCount}</b><span>listos sin conexión</span></div>
      <div><b>${backedUp}</b><span>respaldados</span></div>
      ${s.cacheInfo?.freeBytes != null ? `<div><b>${fmtBytes(s.cacheInfo.freeBytes)}</b><span>libres en el disco</span></div>` : ''}
      <div class="spacer">
        <button class="btn primary" data-act="backup-run" ${state.backup?.running ? 'disabled' : ''}>Respaldar todo</button>
        <button class="btn ghost" data-act="backup-choose">${s.backupDir ? 'Cambiar carpeta' : 'Elegir carpeta'}</button>
      </div>
    </div>
    ${s.backupDir ? `<p class="row-sub" style="margin:-12px 0 18px">Carpeta de respaldo: ${esc(s.backupDir)}${s.backupInfo?.unavailable ? ' (no disponible ahora)' : ''}</p>` : ''}
    <div id="backup-slot">${backupProgressHtml()}</div>
    ${items.length ? `<div>${items.map(downloadRow).join('')}</div>` : '<div class="empty"><h2>Todavía no hay nada guardado</h2><p>Reproduce un video o usa Descargar para tenerlo sin conexión.</p><a class="btn primary" href="#/explorar">Explorar</a></div>'}
  </div>`;
}

function downloadRow(ep) {
  const s = state.status[ep.id];
  const label = s.complete
    ? `${fmtBytes(s.size)}${s.isLocal ? ' · archivo en tu equipo' : ''}`
    : s.size ? `${fmtBytes(s.cachedBytes)} de ${fmtBytes(s.size)}` : '';
  return `<article class="dl-item" data-ep-row="${esc(ep.id)}">
    <a class="ep-card" href="#/ver/${esc(ep.id)}" aria-label="Ver ${esc(ep.title)}"><span class="ep-thumb">${epImg(ep)}</span></a>
    <div>
      <h3>${esc(ep.series.title)} — ${esc(ep.title)}</h3>
      <div class="progress ${s.complete ? 'done' : ''}"><i style="width:${s.percent}%"></i></div>
      <span class="sub">${esc(label)}</span> <span data-badge="${esc(ep.id)}">${statusBadge(ep.id)}</span>
    </div>
    <div class="dl-actions" data-actions="${esc(ep.id)}">
      ${downloadButton(ep.id, true)}
      ${s.complete && !s.backedUp && state.settings.backupDir ? `<button class="btn quiet small" data-act="backup-one" data-id="${esc(ep.id)}">Respaldar</button>` : ''}
      ${!s.complete && s.backedUp ? `<button class="btn quiet small" data-act="restore" data-id="${esc(ep.id)}">Restaurar</button>` : ''}
      ${!s.isLocal && s.cachedBytes > 0 ? `<button class="btn danger small" data-act="remove-cache" data-id="${esc(ep.id)}">Borrar</button>` : ''}
    </div>
  </article>`;
}

function switchRow(key, title, text, checked) {
  return `<div class="set-row">
    <div class="label"><b>${esc(title)}</b><span>${esc(text)}</span></div>
    <label class="switch"><input type="checkbox" data-setting="${key}" aria-label="${esc(title)}" ${checked ? 'checked' : ''}><i></i></label>
  </div>`;
}

function viewSettings() {
  const s = state.settings;
  view.innerHTML = `<div class="page settings">
    <h1 class="page-title">Ajustes</h1>
    <section class="set-section">
      <h2>Reproducción y sin conexión</h2>
      <p>Los videos se sirven desde tu disco siempre que sea posible.</p>
      ${switchRow('autoCache', 'Guardar completo lo que reproduzco', 'Al empezar un video, el resto se descarga en segundo plano. Si lo desactivas solo se guarda lo que veas.', s.autoCache)}
      ${switchRow('offlineMode', 'Modo sin conexión', 'No usa la red aunque haya internet. Sirve para ahorrar datos o comprobar qué tienes guardado.', s.offlineMode)}
      ${switchRow('autoplay', 'Reproducir el siguiente automáticamente', 'Pasa al siguiente video al terminar.', s.autoplay)}
      <div class="set-row">
        <div class="label"><b>Subtítulos preferidos</b><span>Se activan solos si el video los tiene.</span></div>
        <select data-setting-select="subtitleLang" aria-label="Subtítulos preferidos">
          <option value="es" ${s.subtitleLang === 'es' ? 'selected' : ''}>Español</option>
          <option value="en" ${s.subtitleLang === 'en' ? 'selected' : ''}>English</option>
          <option value="off" ${s.subtitleLang === 'off' ? 'selected' : ''}>Desactivados</option>
        </select>
      </div>
    </section>

    <section class="set-section">
      <h2>Caché de videos</h2>
      <p>Akari no la limpia nunca por su cuenta: crece hasta que tú borres videos desde Descargas.</p>
      <div class="set-row">
        <div class="label"><b>${fmtBytes(s.cacheBytes)} guardados</b><span>${esc(s.cacheInfo?.path)}${s.cacheInfo?.freeBytes != null ? ` · ${fmtBytes(s.cacheInfo.freeBytes)} libres` : ''}</span></div>
        <div class="set-actions">
          <button class="btn quiet small" data-act="open-folder" data-id="cache">Abrir</button>
          <button class="btn quiet small" data-act="move-cache">Mover</button>
        </div>
      </div>
    </section>

    <section class="set-section">
      <h2>Sitios integrados</h2>
      <p>Crunchyroll, YouTube y los demás sitios guardan aquí sus archivos temporales para cargar más rápido al volver. Es una caché de navegador: no crea copias de los videos ni sirve sin conexión.</p>
      <div class="set-row">
        <div class="label"><b>${fmtBytes(s.webCacheBytes)} de ${fmtBytes(s.webCacheLimit)} en uso</b><span>Al llegar al límite se reemplaza lo más antiguo. Tu sesión iniciada no se borra al vaciarla.</span></div>
        <button class="btn quiet small" data-act="clear-web-cache" ${s.webCacheBytes ? '' : 'disabled'}>Vaciar</button>
      </div>
    </section>

    <section class="set-section">
      <h2>Respaldos</h2>
      <p>Copia los videos completos a la carpeta que elijas, como archivos normales ordenados por serie.</p>
      <div class="set-row">
        <div class="label"><b>Carpeta de respaldo</b><span>${s.backupDir ? esc(s.backupDir) : 'Sin elegir'}${s.backupInfo?.unavailable ? ' (no disponible ahora)' : s.backupInfo?.freeBytes != null ? ` · ${fmtBytes(s.backupInfo.freeBytes)} libres` : ''}</span></div>
        <div class="set-actions">
          ${s.backupDir ? '<button class="btn quiet small" data-act="open-folder" data-id="backup">Abrir</button>' : ''}
          <button class="btn ghost small" data-act="backup-choose">${s.backupDir ? 'Cambiar' : 'Elegir carpeta'}</button>
        </div>
      </div>
      ${switchRow('autoBackup', 'Respaldar automáticamente', 'Copia cada video a la carpeta en cuanto termina de guardarse.', s.autoBackup)}
      <div class="set-row">
        <div class="label"><b>Respaldar ahora</b><span>Copia lo que falte; lo que ya está no se vuelve a copiar.</span></div>
        <button class="btn primary small" data-act="backup-run" ${!s.backupDir || state.backup?.running ? 'disabled' : ''}>Respaldar todo</button>
      </div>
      <div class="set-row">
        <div class="label"><b>Recuperar un respaldo</b><span>Conecta una carpeta creada antes, también de otro equipo. Trae tus videos, lista y progreso.</span></div>
        <button class="btn quiet small" data-act="backup-import">Elegir respaldo</button>
      </div>
      <div id="backup-slot">${backupProgressHtml()}</div>
    </section>

    <section class="set-section">
      <h2>Agregar a la biblioteca</h2>
      <p>Tus propios videos. Solo agrega contenido que tengas derecho a guardar.</p>
      <div class="set-row">
        <div class="label"><b>Importar una carpeta</b><span>Cada subcarpeta se convierte en una serie. Lee subtítulos .srt y .vtt con el mismo nombre del video.</span></div>
        <button class="btn quiet small" data-act="import-folder">Elegir carpeta</button>
      </div>
      <form id="add-url" style="border-top:1px solid var(--surface-2);padding-top:12px">
        <label class="field">Enlace directo al video (MP4 o WebM)<input name="url" type="url" required placeholder="https://…/video.mp4"></label>
        <label class="field">Serie<input name="seriesTitle" placeholder="Mis enlaces"></label>
        <label class="field">Título<input name="title" placeholder="Se toma del nombre del archivo"></label>
        <button class="btn quiet small">Agregar enlace</button>
      </form>
    </section>
  </div>`;
}

/* ---------- Enrutador ---------- */

function setNavActive(key) {
  for (const a of document.querySelectorAll('#mainnav a')) a.classList.toggle('active', a.dataset.nav === key);
}

export function render() {
  clearInterval(heroTimer);
  const hash = location.hash || '#/';
  const [route, ...rest] = hash.slice(2).split('/');
  const name = route.split('?')[0];
  if (name === 'ver') {
    const ep = findEpisode(rest[0]);
    if (ep) {
      openPlayer(ep);
      return;
    }
  }
  if (isPlayerOpen()) closePlayer();
  // «Crunchyroll» del menú se marca solo en su portada, no en búsquedas de otros sitios.
  const crHome = name === 'web' && new URLSearchParams(route.split('?')[1] || '').get('u') === 'https://www.crunchyroll.com/es';
  setNavActive(name === 'web' ? (crHome ? 'crunchyroll' : '') : name || 'home');
  if (name !== 'web') closeWeb();
  window.scrollTo(0, 0);
  switch (name) {
    case 'web': viewWeb(route.slice(route.indexOf('?') + 1) + (rest.length ? `/${rest.join('/')}` : '')); break;
    case '': viewHome(); break;
    case 'explorar': viewBrowse(); break;
    case 'listas': viewLists(); break;
    case 'historial': viewHistory(); break;
    case 'descargas': viewDownloads(); break;
    case 'ajustes': viewSettings(); break;
    case 'serie': viewSeries(rest[0]); break;
    case 'buscar': viewSearch(decodeURIComponent(rest.join('/'))); break;
    default: viewHome();
  }
}

/** Repinta la vista de datos sin perder la posición ni interrumpir el reproductor. */
function refreshView() {
  if (isPlayerOpen()) return;
  const y = window.scrollY;
  const hash = location.hash || '#/';
  const name = hash.slice(2).split('/')[0].split('?')[0];
  if (name === 'ajustes' && document.activeElement?.matches('input:not([type=checkbox])')) return;
  // La página externa no se recarga por cambios de Akari (descargas, estado de red…).
  if (name === 'web' && state.online) return;
  render();
  window.scrollTo(0, y);
}


/* ---------- Sitios externos dentro de Akari ---------- */

let webOpen = false;
let webObserver = null;

export function webHref(name, url) {
  return `#/web?n=${encodeURIComponent(name)}&u=${encodeURIComponent(url)}`;
}

function slotBounds() {
  const slot = document.getElementById('web-slot');
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function closeWeb() {
  if (!webOpen) return;
  webOpen = false;
  webObserver?.disconnect();
  webObserver = null;
  document.body.classList.remove('web-open', 'watching');
  api.webHide();
}

function paintWebState(s) {
  const bar = document.getElementById('web-bar');
  if (!bar || !s) return;
  bar.querySelector('[data-web="back"]').disabled = !s.canGoBack;
  bar.querySelector('[data-web="forward"]').disabled = !s.canGoForward;
  const where = bar.querySelector('.web-where');
  let host = '';
  try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* página de error */ }
  where.innerHTML = `<b>${esc(s.title || host || 'Cargando…')}</b><span>${esc(host)}</span>`;
  bar.classList.toggle('loading', !!s.loading);
  const msg = document.getElementById('web-error');
  if (s.error) {
    msg.hidden = false;
    msg.innerHTML = `No se pudo abrir el sitio (${esc(s.error.description)}). Revisa tu conexión o pulsa Recargar.`;
  } else {
    msg.hidden = true;
  }
}

function viewWeb(query) {
  const params = new URLSearchParams(query);
  const url = params.get('u') || '';
  const name = params.get('n') || 'Sitio web';
  if (!state.online) {
    closeWeb();
    view.innerHTML = `<div class="empty"><h2>${esc(name)} necesita conexión</h2><p>Cuando vuelva internet podrás verlo aquí mismo.</p><a class="btn primary" href="#/">Ir al inicio</a></div>`;
    return;
  }
  document.body.classList.add('web-open');
  view.innerHTML = `<section class="webpage">
    <div class="web-bar" id="web-bar">
      <button class="p-btn" data-web="back" aria-label="Atrás" title="Atrás" disabled><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M15.400 5.400 14 4l-8 8 8 8 1.400-1.400L8.800 12z"/></svg></button>
      <button class="p-btn" data-web="forward" aria-label="Adelante" title="Adelante" disabled><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="m8.600 5.400 1.400-1.400 8 8-8 8-1.400-1.400 6.600-6.600z"/></svg></button>
      <button class="p-btn" data-web="reload" aria-label="Recargar" title="Recargar"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 4a8 8 0 1 0 7.700 10h-2.100A6 6 0 1 1 12 6c1.600 0 3.100.700 4.200 1.800L13 11h7V4l-2.400 2.400A8 8 0 0 0 12 4z"/></svg></button>
      <span class="web-tag">${esc(name)}</span>
      <div class="web-where"><b>Cargando…</b></div>
      <button class="btn quiet small" data-web="external" title="Abrir esta página en tu navegador">Abrir en el navegador</button>
    </div>
    <div class="web-error" id="web-error" hidden></div>
    <div class="web-slot" id="web-slot"><div class="spinner" role="status" aria-label="Cargando"></div></div>
  </section>`;
  webOpen = true;
  guarded(() => api.webShow(url, slotBounds()));
  webObserver = new ResizeObserver(() => {
    if (webOpen) api.webBounds(slotBounds());
  });
  webObserver.observe(document.getElementById('web-slot'));
}

document.addEventListener('click', (event) => {
  const b = event.target.closest('[data-web]');
  if (b && !b.disabled) api.webNav(b.dataset.web);
});

api.onWebState(paintWebState);
api.onWebFullscreen((on) => {
  // En pantalla completa el video del sitio ocupa toda la ventana de Akari.
  document.body.classList.toggle('watching', on);
  if (!on) requestAnimationFrame(() => { if (webOpen) api.webBounds(slotBounds()); });
});

/* ---------- Acciones ---------- */

const actions = {
  download: (id) => api.download(id),
  pause: (id) => api.pauseDownload(id),
  'download-series': (id) => api.downloadSeries(id),
  async watchlist(id) {
    state.user.watchlist = await api.toggleWatchlist(id);
    refreshView();
  },
  async 'remove-series'(id) {
    const series = state.series.find((s) => s.id === id);
    const ok = await confirmDialog('Quitar de la biblioteca', `«${series.title}» dejará de aparecer en Akari. Tus archivos originales no se borran.`, 'Quitar');
    if (ok) {
      await api.removeSeries(id);
      location.hash = '#/';
    }
  },
  async 'remove-cache'(id) {
    const ep = findEpisode(id);
    const s = state.status[id];
    const extra = s.backedUp ? 'La copia de tu carpeta de respaldo se conserva.' : 'No tiene respaldo: para verlo otra vez tendrás que volver a descargarlo.';
    const ok = await confirmDialog('Borrar de la caché', `¿Borrar «${ep.title}» (${fmtBytes(s.cachedBytes)})? ${extra}`, 'Borrar');
    if (ok) {
      await api.removeCached(id);
      await reloadSettings();
      refreshView();
    }
  },
  async 'backup-choose'() {
    state.settings = await api.chooseBackupFolder();
    state.status = await api.statusAll();
    refreshView();
  },
  async 'backup-run'() {
    if (!state.settings.backupDir) {
      state.settings = await api.chooseBackupFolder();
      if (!state.settings.backupDir) return;
    }
    announceBackup(await api.runBackup(null));
    await afterBackup();
  },
  async 'backup-one'(id) {
    if (!state.settings.backupDir) return;
    announceBackup(await api.runBackup([id]));
    await afterBackup();
  },
  'backup-cancel': () => api.cancelBackup(),
  async 'backup-import'() {
    const result = await api.importBackup();
    if (result) {
      toast(`Respaldo conectado: ${result.videos} videos disponibles.`);
      await reloadAll();
      refreshView();
    }
  },
  async restore(id) {
    toast('Restaurando desde el respaldo…');
    await api.restoreBackup(id);
    await reloadSettings();
    toast('Video restaurado y verificado.');
    refreshView();
  },
  'open-folder': (which) => api.openFolder(which),
  async 'clear-web-cache'() {
    const ok = await confirmDialog('Vaciar caché de sitios', `Se borrarán ${fmtBytes(state.settings.webCacheBytes)} de archivos temporales de Crunchyroll, YouTube y los demás sitios. Tu sesión iniciada se conserva. Los videos guardados de Akari no se tocan.`, 'Vaciar');
    if (ok) {
      state.settings = await api.clearWebCache();
      refreshView();
    }
  },
  async 'move-cache'() {
    state.settings = await api.moveCache();
    state.status = await api.statusAll();
    refreshView();
  },
  async 'import-folder'() {
    const result = await api.importFolder();
    if (result) {
      toast(result.episodes ? `Importados ${result.episodes} videos en ${result.series} series.` : 'No encontré videos en esa carpeta.', !result.episodes);
    }
  },
};

function announceBackup(report) {
  if (!report) return;
  const parts = [];
  if (report.copied.length) parts.push(`${report.copied.length} copiados`);
  if (report.skipped.length) parts.push(`${report.skipped.length} ya estaban`);
  if (report.incomplete.length) parts.push(`${report.incomplete.length} sin terminar de guardar`);
  if (report.failed.length) parts.push(`${report.failed.length} con error`);
  const prefix = report.cancelled ? 'Respaldo cancelado' : 'Respaldo listo';
  toast(`${prefix}: ${parts.join(', ') || 'nada que copiar'}.`, report.failed.length > 0);
  if (report.failed.length) toast(report.failed[0].error, true);
}

async function afterBackup() {
  state.status = await api.statusAll();
  await reloadSettings();
  refreshView();
}

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  event.preventDefault();
  const fn = actions[btn.dataset.act];
  if (fn) guarded(() => fn(btn.dataset.id));
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset.setting) {
    guarded(async () => {
      state.settings = await api.setSettings({ [el.dataset.setting]: el.checked });
      if (el.dataset.setting === 'autoBackup' && el.checked && !state.settings.backupDir) {
        state.settings = await api.chooseBackupFolder();
        if (!state.settings.backupDir) {
          state.settings = await api.setSettings({ autoBackup: false });
        }
        refreshView();
      }
    });
  } else if (el.dataset.settingSelect) {
    guarded(async () => {
      state.settings = await api.setSettings({ [el.dataset.settingSelect]: el.value });
    });
  }
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'add-url') return;
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  guarded(async () => {
    await api.addUrl(data);
    form.reset();
    toast('Enlace agregado a tu biblioteca.');
  });
});

// Si falta una imagen queda visible el fondo de respaldo que está detrás.
document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement && 'hideOnError' in event.target.dataset) event.target.style.display = 'none';
}, true);

let searchTimer;
document.getElementById('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const q = event.target.value.trim();
  searchTimer = setTimeout(() => {
    location.hash = q ? `#/buscar/${encodeURIComponent(q)}` : '#/';
  }, 220);
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => api.setOnline(true));
window.addEventListener('offline', () => api.setOnline(false));

/* ---------- Datos en vivo ---------- */

async function reloadSettings() {
  state.settings = await api.settings();
  state.backup = state.settings.backup;
}

async function reloadAll() {
  [state.series, state.status, state.user] = await Promise.all([api.catalog(), api.statusAll(), api.user()]);
  await reloadSettings();
}

/** Actualiza en sitio lo que depende del estado de un video, sin repintar toda la vista. */
function patchStatus(s) {
  const previous = state.status[s.id];
  state.status[s.id] = s;
  for (const el of document.querySelectorAll(`[data-badge="${CSS.escape(s.id)}"]`)) el.innerHTML = statusBadge(s.id);
  const row = document.querySelector(`.dl-item[data-ep-row="${CSS.escape(s.id)}"]`);
  const ep = row && findEpisode(s.id);
  if (ep) {
    row.outerHTML = downloadRow(ep);
  } else {
    for (const el of document.querySelectorAll(`[data-actions="${CSS.escape(s.id)}"]`)) el.innerHTML = downloadButton(s.id, true);
  }
  const appeared = !previous || previous.cachedBytes === 0;
  if (appeared && (location.hash === '#/descargas') && !row) refreshView();
}

function paintConnectivity() {
  document.getElementById('net-pill').hidden = state.online;
}

api.onStatus(patchStatus);
api.onStatusRefresh(async () => {
  state.status = await api.statusAll();
  refreshView();
});
api.onConnectivity(async ({ online }) => {
  if (online === state.online) return;
  state.online = online;
  paintConnectivity();
  await reloadSettings();
  refreshView();
});
api.onCatalogChanged(async () => {
  await reloadAll();
  refreshView();
  queueThumbs();
});
api.onBackupProgress((status) => {
  state.backup = status;
  const slot = document.getElementById('backup-slot');
  if (slot) slot.innerHTML = backupProgressHtml();
});

/* ---------- Miniaturas de tus videos ----------
 * Los videos importados no traen imagen: se toma un fotograma de cada uno en segundo plano,
 * uno a la vez, solo de lo que ya está en el equipo (no usa internet). Se evita elegir un
 * fotograma negro, como los fundidos del inicio, probando varios momentos del video.
 */
const thumbQueue = [];
const thumbTried = new Set();
let thumbBusy = false;

function needsThumb(ep) {
  const s = state.status[ep.id];
  return !ep.series.art && s && !s.hasThumb && (s.complete || s.backedUp) && !thumbTried.has(ep.id);
}

function queueThumbs() {
  for (const ep of allEpisodes()) {
    if (needsThumb(ep) && !thumbQueue.includes(ep.id)) thumbQueue.push(ep.id);
  }
  // Primero lo que se ve en pantalla.
  const visible = new Set([...document.querySelectorAll('img[src^="media/thumb/"]')].map((i) => i.getAttribute('src').split('/')[2].split('?')[0]));
  thumbQueue.sort((a, b) => Number(visible.has(b)) - Number(visible.has(a)));
  runThumbQueue();
}

function once(target, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tiempo agotado')), ms);
    target.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    target.addEventListener('error', () => { clearTimeout(timer); reject(new Error('no se puede decodificar')); }, { once: true });
  });
}

function brightness(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 16) sum += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  return sum / (data.length / 16);
}

async function makeThumb(id) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = `media/video/${id}`;
  try {
    await once(video, 'loadedmetadata', 20000);
    if (!video.videoWidth || !Number.isFinite(video.duration)) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = Math.round((480 * video.videoHeight) / video.videoWidth);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let best = null;
    for (const frac of [0.12, 0.25, 0.4, 0.6]) {
      video.currentTime = Math.min(video.duration * frac, video.duration - 0.5);
      await once(video, 'seeked', 15000);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const light = brightness(ctx, canvas.width, canvas.height);
      if (!best || light > best.light) best = { light, data: canvas.toDataURL('image/jpeg', 0.82) };
      if (light > 40) break;
    }
    await api.saveThumb(id, best.data);
    return true;
  } catch {
    // Formatos que el reproductor no decodifica (WMV, FLV…): queda el fondo de color.
    return false;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function showThumb(id) {
  if (state.status[id]) state.status[id].hasThumb = true;
  const stamp = Date.now();
  for (const img of document.querySelectorAll(`img[src^="media/thumb/${CSS.escape(id)}"]`)) {
    img.style.display = '';
    img.src = `media/thumb/${id}?v=${stamp}`;
  }
}

async function runThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      // No compite con el reproductor por el disco.
      if (isPlayerOpen()) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const id = thumbQueue.shift();
      thumbTried.add(id);
      if (await makeThumb(id)) showThumb(id);
    }
  } finally {
    thumbBusy = false;
  }
}

window.addEventListener('akari:thumb', (event) => showThumb(event.detail));

export const appApi = {
  refreshUser: async () => { state.user = await api.user(); },
};

(async () => {
  await api.setOnline(navigator.onLine);
  await reloadAll();
  state.online = state.settings.online;
  paintConnectivity();
  render();
  // Deja que la interfaz termine de pintarse antes de leer videos.
  setTimeout(queueThumbs, 1500);
})();
