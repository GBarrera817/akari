'use strict';
// Datos del usuario en un JSON con escritura atómica.

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./media-cache');

const DEFAULTS = {
  settings: {
    cacheDir: null,
    backupDir: null,
    autoBackup: false,
    autoCache: true,
    offlineMode: false,
    autoplay: true,
    subtitleLang: 'es',
  },
  progress: {},
  watchlist: [],
  userSeries: [],
  downloads: {},
};

class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.writing = Promise.resolve();
    let loaded = {};
    try {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Un archivo dañado se conserva aparte: nunca se pisa sin dejar copia.
        try { fs.renameSync(file, `${file}.danado-${Date.now()}`); } catch { /* sin copia posible */ }
      }
    }
    this.data = { ...structuredClone(DEFAULTS), ...loaded };
    this.data.settings = { ...DEFAULTS.settings, ...(loaded.settings || {}) };
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this._write()).catch(() => {});
    }, 400);
  }

  async _write() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, this.data);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(() => this._write()).catch(() => {});
    await this.writing;
  }
}

module.exports = { Store };
