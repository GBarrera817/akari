import { state, esc, fmtTime, findEpisode, appApi } from './app.js';

const api = window.akari;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const ic = {
  play: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M7 4l14 8-14 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M15.400 5.400 14 4l-8 8 8 8 1.400-1.400L8.800 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M5 4l11 8-11 8zm12 0h2v16h-2z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M4 9v6h4l5 5V4L8 9zm12 3a4 4 0 0 0-2-3.500v7A4 4 0 0 0 16 12z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M4 9v6h4l5 5V4L8 9zm16.600.800L19.200 8.400 17 10.600l-2.200-2.200-1.400 1.400 2.200 2.200-2.200 2.200 1.400 1.400 2.200-2.200 2.200 2.200 1.400-1.400-2.200-2.200z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 6h18v2H3zm0 5h12v2H3zm0 5h18v2H3z"/></svg>',
  full: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
};

let session = null;

export function isPlayerOpen() {
  return !!session;
}

export function closePlayer() {
  if (!session) return;
  session.saveProgress();
  session.destroy();
  session = null;
  document.body.classList.remove('watching');
  appApi.refreshUser();
}

export function openPlayer(ep) {
  closePlayer();
  document.body.classList.add('watching');
  session = createSession(ep);
}

function nextEpisode(ep) {
  return ep.series.episodes[ep.index + 1] ? findEpisode(ep.series.episodes[ep.index + 1].id) : null;
}

function createSession(ep) {
  const view = document.getElementById('view');
  const next = nextEpisode(ep);
  view.innerHTML = `<section class="player" id="player">
    <video id="video" preload="auto" playsinline></video>
    <div class="p-status" id="p-status"><div class="spinner" role="status" aria-label="Cargando"></div></div>
    <div class="p-top">
      <button class="p-btn" data-p="back" aria-label="Volver" title="Volver (Esc)">${ic.back}</button>
      <div><div class="series">${esc(ep.series.title)}</div><h1>${esc(ep.title)}</h1></div>
      <div class="right"><span class="source-tag" id="p-source"></span></div>
    </div>
    <div class="p-bottom">
      <div class="seek" id="p-seek" role="slider" tabindex="0" aria-label="Posición del video">
        <div class="seek-track">
          <div id="p-cached"></div>
          <div class="seek-played" id="p-played"></div>
        </div>
        <div class="seek-knob" id="p-knob"></div>
        <div class="seek-tip" id="p-tip" hidden></div>
      </div>
      <div class="p-controls">
        <button class="p-btn" data-p="toggle" id="p-toggle" aria-label="Reproducir o pausar" title="Espacio">${ic.play}</button>
        ${next ? `<button class="p-btn" data-p="next" aria-label="Siguiente" title="Siguiente (N)">${ic.next}</button>` : ''}
        <button class="p-btn" data-p="mute" id="p-mute" aria-label="Silenciar" title="Silenciar (M)">${ic.vol}</button>
        <input class="p-volume" id="p-volume" type="range" min="0" max="1" step="0.02" value="1" aria-label="Volumen">
        <span class="p-time" id="p-time">0:00 / 0:00</span>
        <span class="p-spacer"></span>
        <button class="btn quiet small" data-p="skip85" title="Saltar el opening">+85 s</button>
        <button class="p-btn" data-p="menu" aria-label="Subtítulos y velocidad" title="Subtítulos y velocidad">${ic.gear}</button>
        <button class="p-btn" data-p="full" aria-label="Pantalla completa" title="Pantalla completa (F)">${ic.full}</button>
      </div>
    </div>
    <div class="p-menu" id="p-menu" hidden></div>
    <div class="p-next" id="p-next" hidden></div>
  </section>`;

  const root = view.querySelector('#player');
  const $ = (sel) => root.querySelector(sel);
  const video = $('#video');
  const statusBox = $('#p-status');
  const prev = state.user.progress[ep.id];
  let resumeAt = prev && !prev.watched ? prev.position : 0;
  let hideTimer;
  let rangeTimer;
  let lastSave = 0;
  let countdown = null;
  let dragging = false;
  let destroyed = false;
  let activeLang = null;
  const thumbMissing = !ep.series.art;
  let thumbTaken = false;

  const savedVolume = Number(readPref('volume', 1));
  video.volume = savedVolume;
  $('#p-volume').value = savedVolume;

  function saveProgress() {
    if (video.duration > 0 && video.currentTime > 0) {
      api.setProgress(ep.id, video.currentTime, video.duration);
      state.user.progress[ep.id] = {
        position: video.currentTime,
        duration: video.duration,
        updatedAt: Date.now(),
        watched: video.currentTime / video.duration >= 0.92,
      };
    }
  }

  function showError(title, message, canRetry) {
    statusBox.className = 'p-status card';
    statusBox.innerHTML = `<h2>${esc(title)}</h2><p>${esc(message)}</p>
      ${canRetry ? '<button class="btn primary" data-p="retry">Reintentar</button> ' : ''}
      <button class="btn quiet" data-p="back">Volver</button>`;
    showUi();
  }

  function clearStatus() {
    statusBox.className = 'p-status';
    statusBox.innerHTML = '';
  }

  function loadSource() {
    const src = `media/video/${ep.id}`;
    clearStatus();
    statusBox.innerHTML = '<div class="spinner" role="status" aria-label="Cargando"></div>';
    video.src = `${src}?t=${Date.now()}`;
    video.load();
    video.play().catch(() => {});
  }

  async function explainError() {
    const code = video.error?.code;
    const status = (await api.statusAll().catch(() => ({})))[ep.id];
    if (!state.online && !status?.canPlayOffline) {
      showError('Parte no disponible sin conexión', status?.percent ? `Solo se guardó el ${status.percent}% de este video. Conéctate para completar el resto.` : 'Este video aún no está guardado. Conéctate para verlo y quedará disponible.', true);
    } else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
      const netFail = await fetch(`media/video/${ep.id}`, { headers: { Range: 'bytes=0-0' } }).then(async (r) => (r.ok ? null : (await r.json()).message), () => 'No se pudo abrir el video.');
      if (netFail) showError('No se pudo abrir el video', netFail, true);
      else showError('Formato no compatible', 'El reproductor admite MP4/MOV (H.264) y WebM. Este archivo usa un formato o códec que no puede decodificar, como AVI o HEVC.', false);
    } else {
      showError('Se interrumpió la reproducción', 'Comprueba tu conexión. Lo ya guardado no se pierde.', true);
    }
  }

  /* Pistas: subtítulos (externos e incluidos en el archivo) y audio */
  const subList = ep.subs.map((s) => ({ key: s.lang, label: s.label, lang: s.lang, available: true, forced: false }));
  let audioInfo = [];
  let tracksPending = true;
  let userPickedSub = false;

  function addTrack(sub) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub.label;
    track.id = `sub-${sub.key}`;
    track.srclang = /^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(sub.lang) ? sub.lang : 'und';
    track.src = `media/sub/${ep.id}/${sub.key}`;
    video.append(track);
  }
  subList.forEach(addTrack);

  function setSubtitle(key) {
    activeLang = key;
    for (const track of video.textTracks) track.mode = key && track.id === `sub-${key}` ? 'showing' : 'disabled';
  }

  const LANG_CODES = { es: ['es', 'spa', 'esp'], en: ['en', 'eng'] };
  const LANG_WORDS = { es: /español|latino|castellano|spanish/i, en: /inglés|english/i };
  function matchesLang(sub, wanted) {
    const l = (sub.lang || '').toLowerCase();
    return l === wanted || l.startsWith(`${wanted}-`) || (LANG_CODES[wanted] || []).includes(l)
      || ((l === 'und' || !l) && LANG_WORDS[wanted]?.test(sub.label));
  }

  function applyPreferredSubtitle() {
    if (userPickedSub) return;
    const wanted = state.settings?.subtitleLang;
    if (!wanted || wanted === 'off') {
      setSubtitle(null);
      return;
    }
    // Prefiere los subtítulos completos antes que los «forzados» (solo carteles).
    const options = subList.filter((s) => s.available && matchesLang(s, wanted));
    const pick = options.find((s) => !s.forced) || options[0];
    setSubtitle(pick ? pick.key : null);
  }

  function audioTracks() {
    return video.audioTracks ? [...video.audioTracks] : [];
  }

  function setAudio(index) {
    const list = audioTracks();
    if (!list[index]) return;
    list.forEach((track, i) => { track.enabled = i === index; });
  }

  // Si la pista elegida por el archivo no suena en Akari (AC3, DTS…), usa la primera que sí.
  function applyPreferredAudio() {
    const list = audioTracks();
    const current = list.findIndex((t) => t.enabled);
    if (current >= 0 && audioInfo[current] && !audioInfo[current].playable) {
      const ok = audioInfo.findIndex((a) => a.playable);
      if (ok >= 0) setAudio(ok);
    }
  }

  api.tracks(ep.id).then((info) => {
    if (destroyed) return;
    audioInfo = info.audio || [];
    for (const sub of info.subs || []) {
      subList.push(sub);
      if (sub.available) addTrack(sub);
    }
    tracksPending = false;
    if (video.readyState >= 1) {
      applyPreferredSubtitle();
      applyPreferredAudio();
    }
    if (!$('#p-menu').hidden) renderMenu();
  }).catch(() => { tracksPending = false; });

  /* Menú */
  function renderMenu() {
    const menu = $('#p-menu');
    const tracks = audioTracks();
    const audioHtml = tracks.length > 1
      ? `<h4>Audio</h4>${tracks.map((t, i) => {
        const text = audioInfo[i]?.label || t.label || t.language || `Pista ${i + 1}`;
        return `<button class="${t.enabled ? 'on' : ''}" data-audio="${i}">${esc(text)}</button>`;
      }).join('')}`
      : '';
    const subs = [{ key: null, label: 'Desactivados', available: true }, ...subList];
    menu.innerHTML = `${audioHtml}<h4>Subtítulos</h4>
      ${subs.map((s) => `<button class="${activeLang === s.key ? 'on' : ''}" data-sub="${esc(s.key ?? '')}" ${s.available ? '' : 'disabled'}>${esc(s.label)}</button>`).join('')}
      ${tracksPending ? '<p class="p-menu-note">Leyendo las pistas del video…</p>' : ''}
      <h4>Velocidad</h4>
      ${SPEEDS.map((v) => `<button class="${video.playbackRate === v ? 'on' : ''}" data-speed="${v}">${v === 1 ? 'Normal' : `${v}×`}</button>`).join('')}`;
  }

  /* Barra de progreso */
  function paintTime() {
    const dur = video.duration || 0;
    const t = video.currentTime || 0;
    const pct = dur ? (t / dur) * 100 : 0;
    $('#p-played').style.width = `${pct}%`;
    $('#p-knob').style.left = `${pct}%`;
    $('#p-time').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
    $('#p-seek').setAttribute('aria-valuenow', Math.round(t));
    $('#p-seek').setAttribute('aria-valuetext', fmtTime(t));
  }

  async function paintCached() {
    try {
      const ranges = await api.ranges(ep.id);
      if (destroyed) return;
      $('#p-cached').innerHTML = ranges.map(([a, b]) => `<div class="seek-cached" style="left:${(a * 100).toFixed(2)}%;width:${((b - a) * 100).toFixed(2)}%"></div>`).join('');
      const full = ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === 1;
      const tag = $('#p-source');
      tag.textContent = full ? 'Reproduciendo desde tu disco' : ranges.length ? 'Guardando mientras ves' : '';
      tag.classList.toggle('net', !full);
    } catch { /* la barra se actualizará en el siguiente ciclo */ }
  }

  function seekFromEvent(event) {
    const rect = $('#p-seek').getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function showUi() {
    root.classList.remove('hide-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused && $('#p-menu').hidden && !dragging) root.classList.add('hide-ui');
    }, 2800);
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  }

  function goNext() {
    if (next) location.hash = `#/ver/${next.id}`;
  }

  function goBack() {
    location.hash = `#/serie/${ep.series.id}`;
  }

  function offerNext() {
    if (!next) return;
    const box = $('#p-next');
    const autoplay = state.settings?.autoplay;
    let left = 8;
    const paint = () => {
      box.innerHTML = `<small>A continuación${autoplay ? ` en ${left} s` : ''}</small><b>${esc(next.title)}</b>
        <div><button class="btn primary small" data-p="next">Ver ahora</button><button class="btn quiet small" data-p="cancel-next">Cancelar</button></div>`;
    };
    paint();
    box.hidden = false;
    if (autoplay) {
      countdown = setInterval(() => {
        left--;
        if (left <= 0) goNext();
        else paint();
      }, 1000);
    }
  }

  function captureThumb() {
    if (thumbTaken || !thumbMissing || !video.videoWidth) return;
    thumbTaken = true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = Math.round((480 * video.videoHeight) / video.videoWidth);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      api.saveThumb(ep.id, canvas.toDataURL('image/jpeg', 0.8))
        .then(() => window.dispatchEvent(new CustomEvent('akari:thumb', { detail: ep.id })))
        .catch(() => {});
    } catch { /* sin miniatura se usa el fondo de color */ }
  }

  /* Eventos */
  const onClick = (event) => {
    const speed = event.target.closest('[data-speed]');
    if (speed) {
      video.playbackRate = Number(speed.dataset.speed);
      renderMenu();
      return;
    }
    const audio = event.target.closest('[data-audio]');
    if (audio) {
      setAudio(Number(audio.dataset.audio));
      renderMenu();
      return;
    }
    const sub = event.target.closest('[data-sub]');
    if (sub) {
      if (sub.disabled) return;
      userPickedSub = true;
      setSubtitle(sub.dataset.sub || null);
      renderMenu();
      return;
    }
    const btn = event.target.closest('[data-p]');
    if (!btn) {
      if (event.target === video) {
        if (!$('#p-menu').hidden) $('#p-menu').hidden = true;
        else togglePlay();
      }
      return;
    }
    switch (btn.dataset.p) {
      case 'back': goBack(); break;
      case 'toggle': togglePlay(); break;
      case 'next': goNext(); break;
      case 'mute': video.muted = !video.muted; break;
      case 'full': toggleFull(); break;
      case 'skip85': video.currentTime = Math.min(video.duration || 0, video.currentTime + 85); break;
      case 'retry':
        resumeAt = video.currentTime || resumeAt;
        loadSource();
        break;
      case 'menu': {
        const menu = $('#p-menu');
        menu.hidden = !menu.hidden;
        if (!menu.hidden) renderMenu();
        break;
      }
      case 'cancel-next':
        clearInterval(countdown);
        $('#p-next').hidden = true;
        break;
      default:
    }
  };

  const onKey = (event) => {
    if (document.querySelector('dialog[open]')) return;
    const k = event.key.toLowerCase();
    const handled = {
      ' ': togglePlay,
      k: togglePlay,
      arrowleft: () => { video.currentTime = Math.max(0, video.currentTime - 5); },
      arrowright: () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); },
      arrowup: () => { video.volume = Math.min(1, video.volume + 0.05); },
      arrowdown: () => { video.volume = Math.max(0, video.volume - 0.05); },
      f: toggleFull,
      m: () => { video.muted = !video.muted; },
      n: goNext,
      escape: () => { if (!document.fullscreenElement) goBack(); },
    }[k];
    if (handled) {
      event.preventDefault();
      handled();
      showUi();
    }
  };

  const seekEl = $('#p-seek');
  seekEl.addEventListener('pointerdown', (event) => {
    dragging = true;
    seekEl.setPointerCapture(event.pointerId);
    video.currentTime = seekFromEvent(event) * (video.duration || 0);
    paintTime();
  });
  seekEl.addEventListener('pointermove', (event) => {
    const frac = seekFromEvent(event);
    const tip = $('#p-tip');
    tip.hidden = false;
    tip.style.left = `${frac * 100}%`;
    tip.textContent = fmtTime(frac * (video.duration || 0));
    if (dragging) {
      video.currentTime = frac * (video.duration || 0);
      paintTime();
    }
  });
  seekEl.addEventListener('pointerup', () => { dragging = false; });
  seekEl.addEventListener('pointerleave', () => { $('#p-tip').hidden = true; });

  video.addEventListener('loadedmetadata', () => {
    if (resumeAt > 0 && resumeAt < video.duration - 5) video.currentTime = resumeAt;
    resumeAt = 0;
    applyPreferredSubtitle();
    applyPreferredAudio();
    paintTime();
  });
  video.addEventListener('timeupdate', () => {
    if (!dragging) paintTime();
    if (video.currentTime > 3) captureThumb();
    const now = Date.now();
    if (now - lastSave > 5000) {
      lastSave = now;
      saveProgress();
    }
  });
  video.addEventListener('waiting', () => {
    if (!video.error) statusBox.innerHTML = '<div class="spinner" role="status" aria-label="Cargando"></div>';
  });
  video.addEventListener('playing', clearStatus);
  video.addEventListener('canplay', () => { if (!video.paused || video.readyState >= 3) clearStatus(); });
  video.addEventListener('play', () => {
    $('#p-toggle').innerHTML = ic.pause;
    showUi();
  });
  video.addEventListener('pause', () => {
    $('#p-toggle').innerHTML = ic.play;
    saveProgress();
    showUi();
  });
  video.addEventListener('volumechange', () => {
    $('#p-mute').innerHTML = video.muted || video.volume === 0 ? ic.mute : ic.vol;
    $('#p-volume').value = video.muted ? 0 : video.volume;
    writePref('volume', video.volume);
  });
  video.addEventListener('error', explainError);
  video.addEventListener('ended', () => {
    saveProgress();
    offerNext();
  });
  $('#p-volume').addEventListener('input', (event) => {
    video.muted = false;
    video.volume = Number(event.target.value);
  });

  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', (event) => { if (event.target === video) toggleFull(); });
  root.addEventListener('pointermove', showUi);
  document.addEventListener('keydown', onKey);

  rangeTimer = setInterval(paintCached, 2000);
  paintCached();
  loadSource();
  showUi();

  return {
    saveProgress,
    destroy() {
      destroyed = true;
      clearInterval(rangeTimer);
      clearInterval(countdown);
      clearTimeout(hideTimer);
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}

function readPref(key, fallback) {
  try {
    return localStorage.getItem(`akari.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(`akari.${key}`, String(value));
  } catch { /* preferencia no esencial */ }
}
