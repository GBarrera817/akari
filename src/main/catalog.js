'use strict';
// Catálogo: títulos incluidos (animación con licencia abierta) más lo que agrega el usuario.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { VIDEO_EXTS } = require('./media-cache');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const LANG_RE = /^[a-z0-9-]{1,16}$/i;
const SUB_EXTS = new Set(['srt', 'vtt']);

const BLENDER_CREDIT = 'Blender Foundation · Creative Commons BY';

const BUILTIN = [
  {
    id: 'sintel',
    title: 'Sintel',
    year: 2010,
    rating: '13+',
    genres: ['Fantasía', 'Aventura', 'Drama'],
    description: 'Una joven solitaria cría a un pequeño dragón y, cuando se lo arrebatan, cruza tierras heladas y desiertos para encontrarlo. El final de su búsqueda le exige más de lo que imaginó.',
    credit: BLENDER_CREDIT,
    featured: true,
    art: 'sintel',
    episodes: [
      {
        id: 'sintel-01',
        number: 1,
        title: 'Sintel (película completa)',
        description: 'La historia completa de Sintel y su dragón Scales.',
        durationHint: 888,
        url: 'https://archive.org/download/Sintel/sintel-2048-surround_512kb.mp4',
        subs: [
          { lang: 'es', label: 'Español', url: 'https://durian.blender.org/wp-content/content/subtitles/sintel_es.srt' },
          { lang: 'en', label: 'English', url: 'https://durian.blender.org/wp-content/content/subtitles/sintel_en.srt' },
        ],
      },
      {
        id: 'sintel-02',
        number: 2,
        title: 'Tráiler',
        description: 'Avance oficial de la película en 720p.',
        durationHint: 52,
        url: 'https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4',
        subs: [],
      },
    ],
  },
  {
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    year: 2012,
    rating: '13+',
    genres: ['Ciencia ficción', 'Acción'],
    description: 'En un Ámsterdam del futuro, un grupo de científicos intenta reparar un error del pasado para detener a un ejército de máquinas.',
    credit: BLENDER_CREDIT,
    featured: true,
    art: 'tears-of-steel',
    episodes: [
      {
        id: 'tears-of-steel-01',
        number: 1,
        title: 'Tears of Steel (película completa)',
        description: 'Efectos visuales y actores reales en una batalla contra las máquinas.',
        durationHint: 734,
        url: 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov',
        subs: [],
      },
    ],
  },
  {
    id: 'elephants-dream',
    title: 'Elephants Dream',
    year: 2006,
    rating: '10+',
    genres: ['Ciencia ficción', 'Surrealismo'],
    description: 'Dos personajes recorren una máquina infinita. Uno insiste en que todo tiene un propósito; el otro empieza a dudar de que ese lugar exista de verdad.',
    credit: BLENDER_CREDIT,
    featured: false,
    art: 'elephants-dream',
    episodes: [
      {
        id: 'elephants-dream-01',
        number: 1,
        title: 'Elephants Dream (película completa)',
        description: 'El primer cortometraje abierto de la Blender Foundation.',
        durationHint: 654,
        url: 'https://archive.org/download/ElephantsDream/ed_hd.mp4',
        subs: [],
      },
    ],
  },
  {
    id: 'big-buck-bunny',
    title: 'Big Buck Bunny',
    year: 2008,
    rating: 'TP',
    genres: ['Comedia', 'Familiar'],
    description: 'Un conejo enorme y bonachón disfruta de su mañana hasta que tres roedores abusivos cruzan la línea. Ha llegado la hora de la venganza más tierna.',
    credit: BLENDER_CREDIT,
    featured: true,
    art: 'big-buck-bunny',
    episodes: [
      {
        id: 'big-buck-bunny-01',
        number: 1,
        title: 'Big Buck Bunny (película completa)',
        description: 'Comedia sin diálogos para todas las edades.',
        durationHint: 596,
        url: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',
        subs: [],
      },
    ],
  },
];

function naturalCompare(a, b) {
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

function hashId(prefix, text) {
  return `${prefix}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 14)}`;
}

function cleanTitle(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Limpia una serie que viene de un archivo externo (manifiesto de respaldo). */
function sanitizeSeries(raw) {
  if (!raw || typeof raw.id !== 'string' || !ID_RE.test(raw.id) || !Array.isArray(raw.episodes)) return null;
  const episodes = [];
  for (const ep of raw.episodes) {
    if (!ep || typeof ep.id !== 'string' || !ID_RE.test(ep.id)) continue;
    episodes.push({
      id: ep.id,
      number: Number(ep.number) || episodes.length + 1,
      title: String(ep.title || ep.id).slice(0, 300),
      description: String(ep.description || '').slice(0, 2000),
      // Una ruta local de otro equipo no se adopta: ese video se reproduce desde el respaldo.
      path: null,
      url: isHttpUrl(ep.url) ? ep.url : null,
      subs: (Array.isArray(ep.subs) ? ep.subs : [])
        .filter((s) => s && LANG_RE.test(String(s.lang)))
        .map((s) => ({ lang: s.lang, label: String(s.label || s.lang).slice(0, 60), url: isHttpUrl(s.url) ? s.url : null, path: null })),
    });
  }
  if (!episodes.length) return null;
  return {
    id: raw.id,
    title: String(raw.title || raw.id).slice(0, 300),
    year: Number(raw.year) || null,
    rating: raw.rating ? String(raw.rating).slice(0, 8) : null,
    genres: (Array.isArray(raw.genres) ? raw.genres : ['Mi biblioteca']).map((g) => String(g).slice(0, 40)),
    description: String(raw.description || '').slice(0, 4000),
    credit: raw.credit ? String(raw.credit).slice(0, 200) : null,
    user: true,
    episodes,
  };
}

class Catalog {
  constructor(store) {
    this.store = store;
  }

  series() {
    return [...BUILTIN, ...(this.store.data.userSeries || [])];
  }

  seriesById(id) {
    return this.series().find((s) => s.id === id) || null;
  }

  episode(id) {
    for (const series of this.series()) {
      const ep = series.episodes.find((e) => e.id === id);
      if (ep) return { ...ep, series };
    }
    return null;
  }

  episodes() {
    return this.series().flatMap((s) => s.episodes.map((e) => ({ ...e, series: s })));
  }

  /**
   * Importa una carpeta con videos propios. Cada subcarpeta es una serie;
   * los videos sueltos forman una serie con el nombre de la carpeta elegida.
   */
  async importFolder(root) {
    const groups = new Map();
    const walk = async (dir, seriesName, depth) => {
      const items = await fsp.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (depth < 3) {
            const isSeason = /^(temporada|season|s)\s*\d+$/i.test(item.name) && depth > 0;
            await walk(full, depth === 0 ? cleanTitle(item.name) : isSeason ? seriesName : seriesName, depth + 1);
          }
        } else if (VIDEO_EXTS.has(path.extname(item.name).slice(1).toLowerCase())) {
          if (!groups.has(seriesName)) groups.set(seriesName, []);
          groups.get(seriesName).push(full);
        }
      }
    };
    await walk(root, path.basename(root) || root, 0);

    const added = [];
    for (const [name, files] of groups) {
      files.sort(naturalCompare);
      const seriesId = hashId('user', path.join(root, name).toLowerCase());
      const episodes = [];
      for (const [index, file] of files.entries()) {
        episodes.push({
          id: hashId('local', file.toLowerCase()),
          number: index + 1,
          title: cleanTitle(path.basename(file)),
          description: '',
          path: file,
          url: null,
          subs: await findSidecarSubs(file),
        });
      }
      added.push({
        id: seriesId,
        title: name,
        year: null,
        rating: null,
        genres: ['Mi biblioteca'],
        description: `Importado de ${root}`,
        credit: null,
        user: true,
        episodes,
      });
    }
    this._mergeUserSeries(added);
    return added;
  }

  /** Agrega un video por URL directa (debe ser contenido que tengas derecho a guardar). */
  addUrl({ seriesTitle, title, url }) {
    if (!isHttpUrl(url)) throw new Error('La dirección debe empezar con http:// o https://');
    const name = String(seriesTitle || '').trim() || 'Mis enlaces';
    const seriesId = hashId('user', `url:${name.toLowerCase()}`);
    const existing = (this.store.data.userSeries || []).find((s) => s.id === seriesId);
    const prev = existing ? existing.episodes : [];
    const epId = hashId('url', url);
    if (prev.some((e) => e.id === epId)) throw new Error('Ese enlace ya está en la biblioteca.');
    let fallback = url;
    try { fallback = decodeURIComponent(path.basename(new URL(url).pathname)) || url; } catch { /* usa la URL */ }
    const episode = {
      id: epId,
      number: prev.length + 1,
      title: String(title || '').trim() || cleanTitle(fallback),
      description: '',
      path: null,
      url,
      subs: [],
    };
    this._mergeUserSeries([{
      id: seriesId,
      title: name,
      year: null,
      rating: null,
      genres: ['Mi biblioteca'],
      description: 'Videos agregados por enlace directo.',
      credit: null,
      user: true,
      episodes: [...prev, episode],
    }]);
    return episode;
  }

  /** Quita una serie del catálogo. No toca los archivos originales ni la caché. */
  removeUserSeries(id) {
    this.store.data.userSeries = (this.store.data.userSeries || []).filter((s) => s.id !== id);
    this.store.save();
  }

  /** Une series traídas de un respaldo sin duplicar episodios ya conocidos. */
  mergeFromBackup(rawSeries) {
    const clean = (Array.isArray(rawSeries) ? rawSeries : []).map(sanitizeSeries).filter(Boolean);
    const builtinIds = new Set(BUILTIN.map((s) => s.id));
    this._mergeUserSeries(clean.filter((s) => !builtinIds.has(s.id)));
    return clean.length;
  }

  _mergeUserSeries(list) {
    const current = this.store.data.userSeries || (this.store.data.userSeries = []);
    for (const incoming of list) {
      const existing = current.find((s) => s.id === incoming.id);
      if (!existing) {
        current.push(incoming);
        continue;
      }
      for (const ep of incoming.episodes) {
        const i = existing.episodes.findIndex((e) => e.id === ep.id);
        if (i < 0) existing.episodes.push(ep);
        else if (ep.path || ep.url) existing.episodes[i] = { ...existing.episodes[i], ...ep };
      }
    }
    this.store.save();
  }
}

async function findSidecarSubs(videoFile) {
  const dir = path.dirname(videoFile);
  const base = path.basename(videoFile, path.extname(videoFile)).toLowerCase();
  const candidates = [dir, path.join(dir, 'subs'), path.join(dir, 'Subs'), path.join(dir, 'subtitulos'), path.join(dir, 'Subtitulos')];
  const found = new Map();
  for (const folder of candidates) {
    let names;
    try {
      names = await fsp.readdir(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const ext = path.extname(name).slice(1).toLowerCase();
      if (!SUB_EXTS.has(ext)) continue;
      const stem = name.slice(0, -(ext.length + 1));
      if (stem.toLowerCase() !== base && !stem.toLowerCase().startsWith(`${base}.`)) continue;
      const tag = stem.slice(base.length + 1) || 'und';
      const lang = LANG_RE.test(tag) ? tag.toLowerCase() : 'und';
      if (!found.has(lang)) {
        const label = /^(es|spa|es-\w+)$/i.test(lang) ? 'Español' : lang === 'und' ? 'Subtítulos' : lang.toUpperCase();
        found.set(lang, { lang, label, url: null, path: path.join(folder, name) });
      }
    }
  }
  return [...found.values()];
}

module.exports = { Catalog, BUILTIN, ID_RE, LANG_RE, sanitizeSeries };
