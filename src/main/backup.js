'use strict';
// Respaldos en una carpeta elegida por el usuario. Crea archivos de video normales,
// ordenados por serie, y un manifiesto que permite recuperarlos en otra instalación.
// Solo escribe sus propios archivos y nunca borra nada dentro de la carpeta.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { EventEmitter } = require('node:events');
const { writeJsonAtomic, VIDEO_EXTS } = require('./media-cache');
const { ID_RE, LANG_RE } = require('./catalog');

const MANIFEST = 'akari-respaldo.json';
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function safeName(name) {
  let out = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  if (!out) out = 'sin nombre';
  if (RESERVED.test(out)) out = `_${out}`;
  return out.slice(0, 120).trim();
}

/** Ruta dentro de la carpeta, o null si un manifiesto alterado intenta salir de ella. */
function insideFolder(root, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const full = path.resolve(root, rel);
  const relative = path.relative(path.resolve(root), full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

class BackupCancelled extends Error {}

class BackupManager extends EventEmitter {
  /**
   * @param getFolder () => carpeta de respaldo actual o null
   * @param completeFile (id) => { path, size, ext } de una copia completa fuera del respaldo, o null
   * @param getUserData () => datos del usuario que viajan en el manifiesto
   * @param applyUserData (data) => integra esos datos al importar
   * @param cache MediaCache
   * @param subtitles Subtitles
   * @param catalog Catalog
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
    this.running = null;
    this.index = new Map();
  }

  manifestPath(folder = this.getFolder()) {
    return path.join(folder, MANIFEST);
  }

  async readManifest(folder = this.getFolder()) {
    if (!folder) return null;
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(this.manifestPath(folder), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`El manifiesto de respaldo no se puede leer: ${err.message}`);
    }
    if (parsed?.format !== 'akari-respaldo' || typeof parsed.items !== 'object' || !parsed.items) {
      throw new Error('La carpeta no contiene un respaldo válido de Akari.');
    }
    return parsed;
  }

  /** Vuelve a leer el manifiesto; el índice responde qué videos están respaldados. */
  async refreshIndex() {
    this.index = new Map();
    const folder = this.getFolder();
    if (!folder) return;
    let manifest = null;
    try {
      manifest = await this.readManifest(folder);
    } catch {
      return;
    }
    if (!manifest) return;
    await Promise.all(Object.entries(manifest.items).map(async ([id, item]) => {
      if (!ID_RE.test(id)) return;
      const file = insideFolder(folder, item.file);
      if (!file) return;
      try {
        const stat = await fsp.stat(file);
        if (stat.size === item.size) this.index.set(id, { ...item, path: file });
      } catch { /* copia ausente, por ejemplo un disco externo desconectado */ }
    }));
  }

  /** Copia respaldada de un video, o null. */
  find(id) {
    return this.index.get(id) || null;
  }

  subtitleFile(id, lang) {
    const item = this.find(id);
    const rel = item?.subs?.[lang];
    return rel ? insideFolder(this.getFolder(), rel) : null;
  }

  status() {
    return { running: this.running ? { ...this.running } : null, count: this.index.size };
  }

  cancel() {
    if (this.running) this.running.cancel = true;
  }

  /** Respalda los videos pedidos, o todos los completos si ids es null. */
  async run(ids) {
    const folder = this.getFolder();
    if (!folder) throw new Error('Primero elige una carpeta de respaldo.');
    if (this.running) {
      // Una descarga terminó con otro respaldo en marcha: se suma a la tanda actual.
      if (ids) this.running.pending.push(...ids);
      return this.running.result;
    }
    const targets = ids ? [...ids] : this.catalog.episodes().map((e) => e.id);
    const state = {
      pending: targets,
      done: 0,
      total: targets.length,
      currentTitle: '',
      bytes: 0,
      bytesTotal: 0,
      cancel: false,
    };
    this.running = state;
    state.result = this._runAll(folder, state).finally(() => {
      this.running = null;
      this.emit('progress');
    });
    return state.result;
  }

  async _runAll(folder, state) {
    const report = { copied: [], skipped: [], incomplete: [], failed: [], cancelled: false };
    await fsp.mkdir(folder, { recursive: true });
    const manifest = (await this.readManifest(folder)) || {
      format: 'akari-respaldo',
      version: 1,
      createdAt: new Date().toISOString(),
      items: {},
    };
    try {
      while (state.pending.length) {
        const id = state.pending.shift();
        state.total = Math.max(state.total, state.done + state.pending.length + 1);
        const episode = this.catalog.episode(id);
        if (episode) {
          try {
            await this._backupOne(folder, manifest, episode, state, report);
          } catch (err) {
            if (err instanceof BackupCancelled) throw err;
            report.failed.push({ id, title: episode.title, error: err.message });
          }
        }
        state.done++;
        this.emit('progress');
      }
    } catch (err) {
      if (!(err instanceof BackupCancelled)) throw err;
      report.cancelled = true;
    }
    await this._writeManifest(folder, manifest);
    await this.refreshIndex();
    return report;
  }

  async _writeManifest(folder, manifest) {
    manifest.updatedAt = new Date().toISOString();
    manifest.userSeries = this.catalog.store.data.userSeries || [];
    manifest.userData = this.getUserData();
    await writeJsonAtomic(this.manifestPath(folder), manifest);
  }

  async _backupOne(folder, manifest, episode, state, report) {
    const source = this.completeFile(episode.id);
    if (!source) {
      report.incomplete.push({ id: episode.id, title: episode.title });
      return;
    }
    const seriesDir = safeName(episode.series.title);
    const number = String(episode.number).padStart(2, '0');
    const base = `${number} - ${safeName(episode.title)}`;
    const rel = path.join(seriesDir, `${base}.${source.ext}`);
    const dest = path.join(folder, rel);
    state.currentTitle = episode.title;
    state.bytes = 0;
    state.bytesTotal = source.size;
    this.emit('progress');

    const previous = manifest.items[episode.id];
    let unchanged = false;
    if (previous && previous.size === source.size && previous.sha256) {
      const prevFile = insideFolder(folder, previous.file);
      unchanged = !!prevFile && (await fsp.stat(prevFile).then((s) => s.size === source.size, () => false));
    }

    let item;
    if (unchanged) {
      item = previous;
      report.skipped.push({ id: episode.id, title: episode.title });
    } else {
      const { bfree, bsize } = await fsp.statfs(folder);
      if (bfree * bsize < source.size) {
        throw new Error('No hay espacio suficiente en la carpeta de respaldo.');
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const sha256 = await this._copy(source.path, dest, state);
      item = {
        file: rel,
        size: source.size,
        sha256,
        ext: source.ext,
        title: episode.title,
        seriesId: episode.series.id,
        seriesTitle: episode.series.title,
        number: episode.number,
        url: episode.url || null,
        subs: {},
        backedUpAt: new Date().toISOString(),
      };
      report.copied.push({ id: episode.id, title: episode.title });
    }

    const subs = { ...(item.subs || {}) };
    for (const sub of episode.subs || []) {
      const file = await this.subtitles.ensure(episode.id, sub).catch(() => null);
      if (!file) continue;
      const subRel = path.join(path.dirname(item.file), `${path.basename(item.file, path.extname(item.file))}.${sub.lang}.vtt`);
      await fsp.copyFile(file, path.join(folder, subRel));
      subs[sub.lang] = subRel;
    }
    item = { ...item, subs };

    manifest.items[episode.id] = item;
    // El manifiesto se guarda tras cada video: un corte no invalida lo ya copiado.
    await this._writeManifest(folder, manifest);
    this.index.set(episode.id, { ...item, path: path.join(folder, item.file) });
  }

  /** Copia a un .part y lo renombra al final: nunca queda un video a medias con nombre final. */
  async _copy(from, to, state) {
    const tmp = `${to}.part`;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
      transform: (chunk, _enc, cb) => {
        if (state?.cancel) {
          cb(new BackupCancelled('Cancelado'));
          return;
        }
        hash.update(chunk);
        if (state) {
          state.bytes += chunk.length;
          this._emitThrottled();
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(fs.createReadStream(from), meter, fs.createWriteStream(tmp));
      await fsp.rename(tmp, to);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return hash.digest('hex');
  }

  _emitThrottled() {
    const now = Date.now();
    if (now - (this.lastEmit || 0) > 200) {
      this.lastEmit = now;
      this.emit('progress');
    }
  }

  /** Conecta un respaldo existente: series, progreso y listas pasan a esta instalación. */
  async importFolder(folder) {
    const manifest = await this.readManifest(folder);
    if (!manifest) throw new Error('Esa carpeta no contiene un respaldo de Akari.');
    const series = this.catalog.mergeFromBackup(manifest.userSeries);
    if (manifest.userData) this.applyUserData(manifest.userData);
    return { videos: Object.keys(manifest.items).length, series };
  }

  /** Copia un video del respaldo a la caché verificando su huella. */
  async restore(id) {
    const item = this.find(id);
    if (!item) throw new Error('Ese video no está en el respaldo.');
    if (!VIDEO_EXTS.has(item.ext)) throw new Error('El respaldo indica un formato desconocido.');
    const entry = this.cache.get(id, this.catalog.episode(id)?.url || item.url || '');
    await entry.close();
    await fsp.mkdir(this.cache.dir, { recursive: true });
    const sha256 = await this._copy(item.path, entry.dataPath, null);
    if (item.sha256 && item.sha256 !== sha256) {
      // La copia verificada no calza: se descarta para no dejar un video dañado en caché.
      await this.cache.remove(id);
      throw new Error(`«${item.title}» está dañado en el respaldo (la huella no coincide).`);
    }
    await this.cache.adoptComplete(id, entry.url, { size: item.size, ext: item.ext, sha256 });
    for (const [lang, rel] of Object.entries(item.subs || {})) {
      if (!LANG_RE.test(lang)) continue;
      const file = insideFolder(this.getFolder(), rel);
      if (file) await fsp.copyFile(file, this.subtitles.fileFor(id, lang)).catch(() => {});
    }
  }
}

module.exports = { BackupManager, MANIFEST, safeName, insideFolder };
