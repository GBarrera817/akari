'use strict';
// Pistas incluidas dentro del archivo de video (MKV, MP4…): audio y subtítulos.
// Se leen con ffmpeg. El reproductor de Chromium cambia de pista de audio por sí mismo, pero no
// muestra los subtítulos incluidos: esos se extraen una sola vez a WebVTT y quedan en la caché.

const { execFile } = require('node:child_process');
const fsp = require('node:fs').promises;
const path = require('node:path');

// Subtítulos de texto convertibles; los de imagen (PGS, VobSub) no se pueden pasar a WebVTT.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
// Audio que Chromium puede decodificar. AC3, E-AC3, DTS y TrueHD suenan mudos.
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);

const LANG_NAMES = {
  spa: 'Español', es: 'Español', eng: 'Inglés', en: 'Inglés', jpn: 'Japonés', ja: 'Japonés',
  por: 'Portugués', pt: 'Portugués', fra: 'Francés', fre: 'Francés', fr: 'Francés',
  deu: 'Alemán', ger: 'Alemán', de: 'Alemán', ita: 'Italiano', it: 'Italiano', kor: 'Coreano', ko: 'Coreano',
  zho: 'Chino', chi: 'Chino', zh: 'Chino', rus: 'Ruso', ru: 'Ruso', ara: 'Árabe', ar: 'Árabe',
};

function ffmpegPath() {
  // Empaquetado, el binario vive fuera del .asar para poder ejecutarse.
  return require('ffmpeg-static').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function run(args, timeout) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr || '') });
    });
  });
}

// Títulos que solo repiten el idioma en inglés («English», «Japanese»): se muestra el nombre en español.
const PLAIN_TITLES = /^(english|spanish|japanese|portuguese|french|german|italian|korean|chinese|russian|arabic)$/i;

function label(lang, rawTitle, extra) {
  const name = LANG_NAMES[(lang || '').toLowerCase()];
  const title = name && PLAIN_TITLES.test(rawTitle || '') ? '' : rawTitle;
  let text = title || name || (lang && lang !== 'und' ? lang.toUpperCase() : 'Sin idioma');
  if (title && name && !title.toLowerCase().includes(name.toLowerCase().slice(0, 4))) text = `${title} (${name})`;
  return extra ? `${text} · ${extra}` : text;
}

/** Interpreta el listado de pistas que ffmpeg imprime al abrir un archivo. */
function parseStreams(text) {
  const audio = [];
  const subs = [];
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Stream #0:(\d+)(?:\[0x[0-9a-f]+\])?(?:\(([a-z]{2,3})\))?: (Audio|Subtitle|Video|Data|Attachment): ([A-Za-z0-9_]+)(.*)$/.exec(line);
    if (m) {
      const [, index, lang, kind, codec, rest] = m;
      last = null;
      const base = { index: Number(index), lang: lang || 'und', codec: codec.toLowerCase(), title: '', isDefault: /\(default\)/.test(rest), forced: /\(forced\)/.test(rest) };
      if (kind === 'Audio') {
        last = { ...base, order: audio.length };
        audio.push(last);
      } else if (kind === 'Subtitle') {
        last = { ...base, order: subs.length };
        subs.push(last);
      }
      continue;
    }
    const t = /^\s{4,}title\s*:\s*(.*)$/.exec(line);
    if (t && last && !last.title) last.title = t[1].trim();
    else if (/^\S/.test(line)) last = null;
  }
  return { audio, subs };
}

class MediaTracks {
  constructor({ subsDir }) {
    this.subsDir = subsDir;
    this.probes = new Map();
    this.extractions = new Map();
  }

  fileFor(id, order) {
    return path.join(this.subsDir(), `${id}.emb-${order}.vtt`);
  }

  async probe(file) {
    const stat = await fsp.stat(file);
    const key = `${file}|${stat.size}|${stat.mtimeMs}`;
    if (!this.probes.has(key)) {
      // ffmpeg sin salida termina con error, pero antes imprime las pistas: es lo que se usa.
      this.probes.set(key, run(['-hide_banner', '-i', file], 20000).then((r) => parseStreams(r.stderr)));
    }
    return this.probes.get(key);
  }

  /** Pistas para el reproductor; además prepara los subtítulos en segundo plano. */
  async describe(id, file) {
    const { audio, subs } = await this.probe(file);
    this.extract(id, file).catch(() => {});
    return {
      audio: audio.map((a) => ({
        order: a.order,
        label: label(a.lang, a.title, PLAYABLE_AUDIO.has(a.codec) ? '' : `${a.codec.toUpperCase()}, sin sonido aquí`),
        lang: a.lang,
        playable: PLAYABLE_AUDIO.has(a.codec),
        isDefault: a.isDefault,
      })),
      subs: subs.map((s) => ({
        key: `emb-${s.order}`,
        label: label(s.lang, s.title, TEXT_SUBS.has(s.codec) ? (s.forced ? 'forzados' : '') : 'imagen, no compatible'),
        lang: s.lang,
        available: TEXT_SUBS.has(s.codec),
        forced: s.forced || /forzad|forced|signs|carteles/i.test(s.title),
        isDefault: s.isDefault,
      })),
    };
  }

  /** Extrae de una vez todos los subtítulos de texto del archivo. */
  extract(id, file) {
    if (!this.extractions.has(id)) {
      const job = (async () => {
        const { subs } = await this.probe(file);
        const wanted = [];
        for (const s of subs.filter((x) => TEXT_SUBS.has(x.codec))) {
          const out = this.fileFor(id, s.order);
          if (!(await fsp.access(out).then(() => true, () => false))) wanted.push({ s, out });
        }
        if (!wanted.length) return;
        await fsp.mkdir(this.subsDir(), { recursive: true });
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file];
        for (const { s, out } of wanted) args.push('-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', `${out}.part`);
        // Leer todo el archivo puede tardar en videos grandes; nunca más de 10 minutos.
        const r = await run(args, 10 * 60 * 1000);
        for (const { out } of wanted) {
          if (r.ok) await fsp.rename(`${out}.part`, out).catch(() => {});
          else await fsp.rm(`${out}.part`, { force: true });
        }
        if (!r.ok) throw new Error(r.stderr.trim().split('\n').pop() || 'No se pudieron leer los subtítulos.');
      })();
      job.catch(() => this.extractions.delete(id));
      this.extractions.set(id, job);
    }
    return this.extractions.get(id);
  }

  /** Ruta del .vtt de un subtítulo incluido; espera a la extracción si hace falta. */
  async subtitle(id, file, order) {
    const out = this.fileFor(id, order);
    if (await fsp.access(out).then(() => true, () => false)) return out;
    if (!file) return null;
    await this.extract(id, file);
    return (await fsp.access(out).then(() => true, () => false)) ? out : null;
  }
}

module.exports = { MediaTracks, parseStreams };
