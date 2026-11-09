'use strict';
// Subtítulos: se convierten a WebVTT y se guardan junto a la caché para el modo sin conexión.

const fsp = require('node:fs').promises;
const path = require('node:path');

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Muchos .srt antiguos en español vienen en Windows-1252.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function toVtt(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (clean.startsWith('WEBVTT')) return `${clean}\n`;
  const body = clean.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

class Subtitles {
  constructor({ dir, fetchImpl, isOffline }) {
    this.dir = dir;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.isOffline = isOffline || (() => false);
    this.pending = new Map();
  }

  fileFor(id, lang) {
    return path.join(this.dir, `${id}.${lang}.vtt`);
  }

  /** Devuelve la ruta del .vtt, descargándolo o convirtiéndolo si aún no está. Null si no se puede. */
  ensure(id, sub) {
    // El video y la pista piden el mismo subtítulo a la vez: se comparte una sola tarea.
    const file = this.fileFor(id, sub.lang);
    let task = this.pending.get(file);
    if (!task) {
      task = this._fetchAndStore(file, sub).finally(() => this.pending.delete(file));
      this.pending.set(file, task);
    }
    return task;
  }

  async _fetchAndStore(file, sub) {
    try {
      await fsp.access(file);
      return file;
    } catch { /* aún no está guardado */ }
    let bytes = null;
    if (sub.path) {
      bytes = await fsp.readFile(sub.path).catch(() => null);
    }
    if (!bytes && sub.url && !this.isOffline()) {
      try {
        const res = await this.fetch(sub.url, { headers: { 'User-Agent': 'Akari/1.0' }, signal: AbortSignal.timeout(20000) });
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } catch { /* sin red: se informa como no disponible */ }
    }
    if (!bytes) return null;
    await fsp.mkdir(this.dir, { recursive: true });
    // Con renombrado final, nadie puede leer un archivo a medio escribir.
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, toVtt(decodeText(bytes)));
    await fsp.rename(tmp, file);
    return file;
  }

  async ensureAll(episode) {
    await Promise.all((episode.subs || []).map((s) => this.ensure(episode.id, s)));
  }

  async remove(id, subs) {
    await Promise.all((subs || []).map((s) => fsp.rm(this.fileFor(id, s.lang), { force: true })));
  }
}

module.exports = { Subtitles, toVtt, decodeText };
