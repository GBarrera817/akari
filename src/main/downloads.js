'use strict';
// Cola de descargas completas. Comparte bloques con la reproducción: lo que ya se vio
// no se vuelve a pedir y lo que se descarga queda disponible al instante para el reproductor.

const { EventEmitter } = require('node:events');

const MAX_ACTIVE = 2;

class DownloadManager extends EventEmitter {
  /**
   * @param cache MediaCache
   * @param resolveUrl (id) => URL remota o null
   * @param persisted objeto { id: { state, error? } } que sobrevive reinicios
   * @param onChange se llama cuando hay que guardar `persisted`
   */
  constructor({ cache, resolveUrl, persisted, onChange }) {
    super();
    this.cache = cache;
    this.resolveUrl = resolveUrl;
    this.states = persisted;
    this.onChange = onChange || (() => {});
    this.queue = [];
    this.active = new Map();
    this.pumping = false;
  }

  stateOf(id) {
    return this.states[id] || { state: 'idle' };
  }

  _set(id, state, error) {
    this.states[id] = error ? { state, error } : { state };
    this.onChange();
    this.emit('state', id);
  }

  start(id) {
    if (this.active.has(id) || this.queue.includes(id)) return;
    if (!this.resolveUrl(id)) return;
    this.queue.push(id);
    this._set(id, 'queued');
    this._pump();
  }

  pause(id) {
    const job = this.active.get(id);
    if (job) job.stop = true;
    this.queue = this.queue.filter((q) => q !== id);
    this._set(id, 'paused');
  }

  /** Olvida el estado de un video (al borrarlo de la caché). */
  async forget(id) {
    const job = this.active.get(id);
    if (job) {
      job.stop = true;
      await job.done;
    }
    this.queue = this.queue.filter((q) => q !== id);
    delete this.states[id];
    this.onChange();
    this.emit('state', id);
  }

  /** Reanuda lo que quedó pendiente: al abrir la app y al recuperar la conexión. */
  resumePending() {
    for (const [id, s] of Object.entries(this.states)) {
      if (['queued', 'downloading', 'waiting'].includes(s.state)) this.start(id);
    }
  }

  isBusy() {
    return this.active.size > 0 || this.queue.length > 0;
  }

  stopAll() {
    this.queue = [];
    for (const job of this.active.values()) job.stop = true;
    return Promise.allSettled([...this.active.values()].map((j) => j.done));
  }

  _pump() {
    while (this.active.size < MAX_ACTIVE && this.queue.length) {
      const id = this.queue.shift();
      const job = { stop: false };
      job.done = this._run(id, job).finally(() => {
        this.active.delete(id);
        this._pump();
      });
      this.active.set(id, job);
    }
  }

  async _run(id, job) {
    this._set(id, 'downloading');
    try {
      const entry = this.cache.get(id, this.resolveUrl(id));
      await entry.prepare();
      let i = entry.firstMissing(0);
      while (i >= 0 && !job.stop) {
        await entry.ensureChunk(i);
        i = entry.firstMissing(i);
      }
      if (!job.stop) {
        await entry.flush();
        this._set(id, 'done');
        this.emit('done', id);
      }
    } catch (err) {
      if (job.stop) return;
      if (err.code === 'SOURCE_CHANGED') {
        this.queue.push(id);
        return;
      }
      if (err.code === 'OFFLINE' || err.code === 'NETWORK') {
        this._set(id, 'waiting', err.message);
      } else {
        this._set(id, 'error', err.message);
      }
    }
  }
}

module.exports = { DownloadManager };
