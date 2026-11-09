'use strict';
// Caché persistente de video por bloques.
// Lo que se reproduce se guarda en disco a medida que llega, de modo que volver a
// verlo no usa la red. Nada se expulsa de forma automática: un bloque solo
// desaparece si el usuario borra el video o si la fuente remota cambió de contenido.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const CHUNK_SIZE = 1024 * 1024;
const READ_AHEAD_CHUNKS = 16;
const JUMP_THRESHOLD_CHUNKS = 2;
const MAX_RETRIES = 3;
const IDLE_TIMEOUT_MS = 30000;
const READ_SLICE = 256 * 1024;
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi']);

class MediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function extFrom(url, contentType) {
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (VIDEO_EXTS.has(ext)) return ext;
  } catch { /* URL no válida: se decide por el tipo */ }
  if (/webm/i.test(contentType || '')) return 'webm';
  if (/matroska/i.test(contentType || '')) return 'mkv';
  if (/quicktime/i.test(contentType || '')) return 'mov';
  return 'mp4';
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      // En Windows un antivirus puede retener el archivo unos milisegundos.
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

function markSparse(file) {
  // Sin esto, escribir cerca del final de un archivo nuevo obliga a NTFS a rellenar
  // con ceros todo lo anterior y un salto largo tarda segundos. Si falla, solo es más lento.
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('fsutil', ['sparse', 'setflag', file], { windowsHide: true }, () => resolve());
  });
}

class CacheEntry {
  constructor(cache, id, url) {
    this.cache = cache;
    this.id = id;
    this.url = url;
    this.metaPath = path.join(cache.dir, `${id}.json`);
    this.dataPath = path.join(cache.dir, `${id}.media`);
    this.meta = null;
    this.bits = null;
    this.count = 0;
    this.inflight = new Map();
    this.runs = new Set();
    this.activeRuns = new Set();
    this.fh = null;
    this.fhPromise = null;
    this.flushTimer = null;
    this.closed = false;
  }

  get ready() { return !!this.meta && this.meta.size > 0; }
  get totalChunks() { return Math.ceil(this.meta.size / CHUNK_SIZE); }
  get complete() { return this.ready && this.count === this.totalChunks; }
  get cachedBytes() {
    if (!this.ready) return 0;
    if (this.complete) return this.meta.size;
    const lastIdx = this.totalChunks - 1;
    return this.count * CHUNK_SIZE - (this.has(lastIdx) ? CHUNK_SIZE - this._chunkLen(lastIdx) : 0);
  }

  has(i) { return (this.bits[i >> 3] & (1 << (i & 7))) !== 0; }
  _chunkLen(i) { return Math.min(CHUNK_SIZE, this.meta.size - i * CHUNK_SIZE); }

  /** Rangos guardados como fracciones de 0 a 1, para pintar la barra del reproductor. */
  ranges() {
    if (!this.ready) return [];
    const total = this.totalChunks;
    const out = [];
    let start = -1;
    for (let i = 0; i <= total; i++) {
      const on = i < total && this.has(i);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        out.push([start / total, i / total]);
        start = -1;
      }
    }
    return out;
  }

  firstMissing(from = 0) {
    for (let i = from; i < this.totalChunks; i++) if (!this.has(i)) return i;
    return -1;
  }

  /** Lee los metadatos del disco sin usar la red. */
  async load() {
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(this.metaPath, 'utf8'));
    } catch {
      return false;
    }
    if (this.url && meta.url && meta.url !== this.url) return false;
    let stat;
    try {
      stat = await fsp.stat(this.dataPath);
    } catch {
      return false;
    }
    const bits = Buffer.from(meta.chunks || '', 'base64');
    if (!(meta.size > 0) || bits.length !== Math.ceil(Math.ceil(meta.size / CHUNK_SIZE) / 8)) return false;
    this.meta = meta;
    this.bits = bits;
    this.count = 0;
    for (let i = 0; i < this.totalChunks; i++) if (this.has(i)) this.count++;
    // Si el archivo quedó más corto que lo anotado no se puede confiar en los bloques.
    const highest = this._highestChunkEnd();
    if (stat.size < highest) this._clearBits();
    return true;
  }

  _highestChunkEnd() {
    for (let i = this.totalChunks - 1; i >= 0; i--) {
      if (this.has(i)) return i * CHUNK_SIZE + this._chunkLen(i);
    }
    return 0;
  }

  _clearBits() {
    this.bits.fill(0);
    this.count = 0;
    this.meta.sha256 = null;
  }

  /** Garantiza conocer el tamaño de la fuente. Solo usa la red si aún no se conoce. */
  async prepare() {
    if (this.ready) return;
    if (!this.prepPromise) {
      this.prepPromise = (async () => {
        if (await this.load()) return;
        await this._probe(true);
      })().finally(() => { this.prepPromise = null; });
    }
    await this.prepPromise;
  }

  async _probe(fresh) {
    if (!this.url) throw new MediaError('NO_SOURCE', 'Este video no tiene una fuente remota.');
    if (this.cache.isOffline()) throw new MediaError('OFFLINE', 'Este video no está guardado y no hay conexión.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
    let res;
    try {
      res = await this.cache.fetch(this.url, { headers: { Range: 'bytes=0-0', 'User-Agent': 'Akari/1.0' }, signal: ctrl.signal });
    } catch (err) {
      throw new MediaError('NETWORK', `No se pudo conectar con la fuente: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    let size = 0;
    let acceptRanges = false;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (m) size = Number(m[1]);
      acceptRanges = size > 0;
    } else if (res.ok) {
      size = Number(res.headers.get('content-length')) || 0;
    } else {
      ctrl.abort();
      throw new MediaError('HTTP', `La fuente respondió ${res.status}.`);
    }
    const etag = res.headers.get('etag');
    const contentType = res.headers.get('content-type') || '';
    ctrl.abort();
    if (!size) throw new MediaError('UNKNOWN_SIZE', 'La fuente no informa el tamaño del video.');
    if (fresh || !this.meta) {
      const bytes = Math.ceil(Math.ceil(size / CHUNK_SIZE) / 8);
      this.bits = Buffer.alloc(bytes);
      this.count = 0;
      this.meta = {
        id: this.id,
        url: this.url,
        size,
        etag: etag && !etag.startsWith('W/') ? etag : null,
        ext: extFrom(this.url, contentType),
        acceptRanges,
        chunks: '',
        sha256: null,
        createdAt: Date.now(),
      };
      await fsp.mkdir(this.cache.dir, { recursive: true });
      await fsp.writeFile(this.dataPath, '');
      if (size > 32 * CHUNK_SIZE) await markSparse(this.dataPath);
      await this.flush();
    }
    return { size, etag, acceptRanges };
  }

  async _handle() {
    if (this.fh) return this.fh;
    if (!this.fhPromise) {
      this.fhPromise = (async () => {
        await fsp.mkdir(this.cache.dir, { recursive: true });
        // 'a' crea el archivo si falta sin truncarlo; 'r+' permite escribir en cualquier posición.
        await (await fsp.open(this.dataPath, 'a')).close();
        this.fh = await fsp.open(this.dataPath, 'r+');
        return this.fh;
      })().finally(() => { this.fhPromise = null; });
    }
    return this.fhPromise;
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => { /* se reintenta con el siguiente bloque */ });
    }, 1500);
  }

  async flush() {
    if (!this.meta) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.meta.chunks = this.bits.toString('base64');
    await writeJsonAtomic(this.metaPath, this.meta);
  }

  /** Promesa que se cumple cuando el bloque i ya está en disco. */
  ensureChunk(i) {
    if (this.has(i)) return Promise.resolve();
    const pending = this.inflight.get(i);
    if (pending) {
      this._jumpTo(i);
      return pending.promise;
    }
    if (this.cache.isOffline()) {
      return Promise.reject(new MediaError('OFFLINE', 'Esta parte del video no está guardada y no hay conexión.'));
    }
    let first = i;
    let last;
    if (this.meta.acceptRanges) {
      last = i;
      const limit = Math.min(i + READ_AHEAD_CHUNKS - 1, this.totalChunks - 1);
      while (last < limit && !this.has(last + 1) && !this.inflight.has(last + 1)) last++;
    } else {
      // Sin soporte de rangos la única lectura posible es de principio a fin.
      first = 0;
      last = this.totalChunks - 1;
    }
    for (let c = first; c <= last; c++) {
      if (this.has(c) || this.inflight.has(c)) continue;
      const waiter = {};
      waiter.promise = new Promise((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
      });
      // Evita avisos de promesa sin atender: no todos los bloques tienen a alguien esperando.
      waiter.promise.catch(() => {});
      this.inflight.set(c, waiter);
    }
    this._startRun(first, last);
    return this.inflight.get(i).promise;
  }

  _startRun(first, last) {
    const state = { next: first, last };
    this.activeRuns.add(state);
    const run = this._run(state).finally(() => {
      this.activeRuns.delete(state);
      this.runs.delete(run);
    });
    this.runs.add(run);
  }

  // Un salto a un bloque que otra lectura aún tardará en alcanzar no debe esperarla:
  // esa lectura se recorta y el tramo restante se pide de inmediato desde el salto.
  _jumpTo(i) {
    if (!this.meta.acceptRanges) return;
    for (const run of this.activeRuns) {
      if (run.next <= i && i <= run.last && i - run.next > JUMP_THRESHOLD_CHUNKS) {
        const oldLast = run.last;
        run.last = i - 1;
        this._startRun(i, oldLast);
        return;
      }
    }
  }

  _failRange(from, to, err) {
    for (let c = from; c <= to; c++) {
      const w = this.inflight.get(c);
      if (w && !this.has(c)) {
        this.inflight.delete(c);
        w.reject(err);
      }
    }
  }

  async _run(state) {
    let attempts = 0;
    while (state.next <= state.last && !this.closed) {
      const before = state.next;
      try {
        await this._fetchInto(state);
      } catch (err) {
        if (state.next > before) attempts = 0;
        const fatal = err instanceof MediaError && err.code !== 'NETWORK';
        const stop = fatal || this.closed || this.cache.isOffline() || ++attempts > MAX_RETRIES;
        if (stop) {
          this._failRange(state.next, state.last, err instanceof MediaError ? err : new MediaError('NETWORK', err.message));
          return;
        }
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempts));
      }
    }
    if (this.closed) this._failRange(state.next, state.last, new MediaError('CLOSED', 'El video se cerró.'));
  }

  async _fetchInto(state) {
    const ranged = this.meta.acceptRanges;
    const startByte = ranged ? state.next * CHUNK_SIZE : 0;
    const endByte = Math.min((state.last + 1) * CHUNK_SIZE, this.meta.size) - 1;
    const headers = { 'User-Agent': 'Akari/1.0' };
    if (ranged) {
      headers.Range = `bytes=${startByte}-${endByte}`;
      if (this.meta.etag) headers['If-Range'] = this.meta.etag;
    }
    const ctrl = new AbortController();
    state.ctrl = ctrl;
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
    };
    touch();
    try {
      let res;
      try {
        res = await this.cache.fetch(this.url, { headers, signal: ctrl.signal });
      } catch (err) {
        throw new MediaError('NETWORK', err.message);
      }
      if (ranged && res.status === 200) await this._sourceChanged(ctrl);
      if (ranged && res.status === 206) {
        const m = /bytes (\d+)-\d+\/(\d+)/.exec(res.headers.get('content-range') || '');
        if (!m || Number(m[1]) !== startByte) throw new MediaError('NETWORK', 'Respuesta de rango inesperada.');
        if (Number(m[2]) !== this.meta.size) await this._sourceChanged(ctrl);
      }
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        throw new MediaError(retryable ? 'NETWORK' : 'HTTP', `La fuente respondió ${res.status}.`);
      }

      const reader = res.body.getReader();
      let chunkIdx = ranged ? state.next : 0;
      let buf = Buffer.allocUnsafeSlow(this._chunkLen(chunkIdx));
      let filled = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        let offset = 0;
        while (offset < value.length) {
          const n = Math.min(value.length - offset, buf.length - filled);
          buf.set(value.subarray(offset, offset + n), filled);
          filled += n;
          offset += n;
          if (filled === buf.length) {
            await this._commitChunk(chunkIdx, buf);
            if (chunkIdx === state.next) state.next = chunkIdx + 1;
            chunkIdx++;
            if (chunkIdx > state.last) {
              await reader.cancel().catch(() => {});
              return;
            }
            buf = Buffer.allocUnsafeSlow(this._chunkLen(chunkIdx));
            filled = 0;
          }
        }
      }
      if (chunkIdx <= state.last) throw new MediaError('NETWORK', 'La conexión se cortó antes de tiempo.');
    } catch (err) {
      if (err instanceof MediaError) throw err;
      if (err.code === 'ENOSPC') throw new MediaError('DISK_FULL', 'No queda espacio en el disco de la caché.');
      throw new MediaError('NETWORK', err.message);
    } finally {
      clearTimeout(idle);
      ctrl.abort();
    }
  }

  // Si el archivo remoto cambió, los bloques guardados son de otra versión y mezclarlos
  // corrompería el video: este es el único caso en que la caché se invalida sola.
  async _sourceChanged(ctrl) {
    ctrl.abort();
    const info = await this._probe(false);
    const bytes = Math.ceil(Math.ceil(info.size / CHUNK_SIZE) / 8);
    this.meta.size = info.size;
    this.meta.etag = info.etag && !info.etag.startsWith('W/') ? info.etag : null;
    this.meta.acceptRanges = info.acceptRanges;
    this.bits = Buffer.alloc(bytes);
    this.count = 0;
    this.meta.sha256 = null;
    for (const [c, w] of this.inflight) {
      this.inflight.delete(c);
      w.reject(new MediaError('SOURCE_CHANGED', 'El video cambió en el origen; se volverá a descargar.'));
    }
    await this.flush();
    throw new MediaError('SOURCE_CHANGED', 'El video cambió en el origen; se volverá a descargar.');
  }

  async _commitChunk(i, buf) {
    if (!this.has(i)) {
      const fh = await this._handle();
      let written = 0;
      while (written < buf.length) {
        const { bytesWritten } = await fh.write(buf, written, buf.length - written, i * CHUNK_SIZE + written);
        written += bytesWritten;
      }
      this.bits[i >> 3] |= 1 << (i & 7);
      this.count++;
      this.cache.emit('progress', this);
      if (this.complete) {
        await this.flush();
        this.cache.emit('complete', this);
      } else {
        this._scheduleFlush();
      }
    }
    const w = this.inflight.get(i);
    if (w) {
      this.inflight.delete(i);
      w.resolve();
    }
  }

  /** Flujo de bytes [start, end]. Sirve desde disco y pide a la red solo lo que falte. */
  stream(start, end) {
    const entry = this;
    let pos = start;
    let cancelled = false;
    return new ReadableStream({
      async pull(ctrl) {
        try {
          const i = Math.floor(pos / CHUNK_SIZE);
          if (!entry.has(i)) await entry.ensureChunk(i);
          if (cancelled) return;
          const chunkEnd = Math.min((i + 1) * CHUNK_SIZE - 1, end);
          const len = Math.min(chunkEnd - pos + 1, READ_SLICE);
          const buf = Buffer.allocUnsafeSlow(len);
          const fh = await entry._handle();
          const { bytesRead } = await fh.read(buf, 0, len, pos);
          if (bytesRead === 0) throw new MediaError('CORRUPT', 'El archivo de caché está incompleto.');
          ctrl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
          pos += bytesRead;
          if (pos > end) ctrl.close();
        } catch (err) {
          if (!cancelled) ctrl.error(err);
        }
      },
      cancel() { cancelled = true; },
    });
  }

  async close() {
    this.closed = true;
    // Corta las lecturas en curso: cerrar la app no debe esperar a una red lenta.
    for (const run of this.activeRuns) run.ctrl?.abort();
    await Promise.allSettled([...this.runs]);
    await this.flush().catch(() => {});
    if (this.fh) {
      await this.fh.close().catch(() => {});
      this.fh = null;
    }
    this.closed = false;
  }
}

class MediaCache extends EventEmitter {
  constructor({ dir, fetchImpl, isOffline }) {
    super();
    this.dir = dir;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.isOffline = isOffline || (() => false);
    this.entries = new Map();
  }

  get(id, url) {
    let e = this.entries.get(id);
    if (!e) {
      e = new CacheEntry(this, id, url);
      this.entries.set(id, e);
    } else if (url && !e.url) {
      e.url = url;
    }
    return e;
  }

  /** Carga todo lo guardado al arrancar, para saber sin red qué se puede ver. */
  async loadAll() {
    await fsp.mkdir(this.dir, { recursive: true });
    const names = await fsp.readdir(this.dir);
    await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => {
      const id = n.slice(0, -5);
      const entry = this.get(id, '');
      if (!entry.ready) await entry.load();
    }));
  }

  /** Registra como completo un archivo que ya está en dataPath (usado al restaurar). */
  async adoptComplete(id, url, { size, ext, sha256 }) {
    const entry = this.get(id, url);
    await entry.close();
    entry.url = url;
    const total = Math.ceil(size / CHUNK_SIZE);
    entry.bits = Buffer.alloc(Math.ceil(total / 8));
    for (let i = 0; i < total; i++) entry.bits[i >> 3] |= 1 << (i & 7);
    entry.count = total;
    entry.meta = { id, url, size, etag: null, ext, acceptRanges: true, chunks: '', sha256, createdAt: Date.now() };
    await entry.flush();
    return entry;
  }

  /** Borra un video de la caché. Solo se llama por una acción explícita del usuario. */
  async remove(id) {
    const entry = this.entries.get(id);
    if (entry) {
      await entry.close();
      this.entries.delete(id);
    }
    const base = path.join(this.dir, id);
    await Promise.all([fsp.rm(`${base}.media`, { force: true }), fsp.rm(`${base}.json`, { force: true })]);
  }

  async closeAll() {
    await Promise.all([...this.entries.values()].map((e) => e.close()));
  }

  totalBytes() {
    let total = 0;
    for (const e of this.entries.values()) total += e.cachedBytes;
    return total;
  }
}

module.exports = { MediaCache, CacheEntry, MediaError, CHUNK_SIZE, VIDEO_EXTS, extFrom, writeJsonAtomic };
