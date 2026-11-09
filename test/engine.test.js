'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MediaCache, CHUNK_SIZE } = require('../src/main/media-cache');
const { DownloadManager } = require('../src/main/downloads');
const { BackupManager, safeName, insideFolder, MANIFEST } = require('../src/main/backup');
const { Subtitles, toVtt, decodeText } = require('../src/main/subtitles');
const { sanitizeSeries } = require('../src/main/catalog');
const { parseStreams } = require('../src/main/media-tracks');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'akari-test-'));
}

function makeBytes(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** Servidor HTTP con rangos que cuenta cuántos bytes entrega. */
async function startServer(state) {
  state.served = 0;
  state.requests = 0;
  const server = http.createServer((req, res) => {
    state.requests++;
    const body = state.body;
    res.setHeader('ETag', state.etag || '"v1"');
    res.setHeader('Content-Type', 'video/mp4');
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const ifRange = req.headers['if-range'];
    if (state.noRanges || !m || (ifRange && ifRange !== (state.etag || '"v1"'))) {
      res.setHeader('Content-Length', body.length);
      res.writeHead(200);
      state.served += body.length;
      res.end(body);
      return;
    }
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
    res.setHeader('Content-Length', end - start + 1);
    res.writeHead(206);
    const slice = body.subarray(start, end + 1);
    state.served += slice.length;
    state.starts?.push(start);
    if (state.throttleMs) {
      // Entrega lenta en trozos, para simular una conexión real con espera.
      let offset = 0;
      const timer = setInterval(() => {
        res.write(slice.subarray(offset, offset + CHUNK_SIZE / 2));
        offset += CHUNK_SIZE / 2;
        if (offset >= slice.length) {
          clearInterval(timer);
          res.end();
        }
      }, state.throttleMs);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(slice);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v.mp4`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

test('una lectura guarda bloques y la segunda no usa la red', async () => {
  const state = { body: makeBytes(5 * CHUNK_SIZE + 1234) };
  const srv = await startServer(state);
  const dir = tempDir();
  const cache = new MediaCache({ dir });
  const entry = cache.get('a', srv.url);
  await entry.prepare();
  const start = 2 * CHUNK_SIZE + 10;
  const end = 3 * CHUNK_SIZE + 99;
  assert.deepStrictEqual(await readAll(entry.stream(start, end)), state.body.subarray(start, end + 1));
  await Promise.allSettled([...entry.runs]);
  const requests = state.requests;
  assert.deepStrictEqual(await readAll(entry.stream(start, end)), state.body.subarray(start, end + 1));
  assert.strictEqual(state.requests, requests, 'no debe haber peticiones nuevas');
  await cache.closeAll();
  await srv.close();
});

test('saltar a un bloque ya en camino no espera a la lectura secuencial', async () => {
  const state = { body: makeBytes(16 * CHUNK_SIZE), throttleMs: 150, starts: [] };
  const srv = await startServer(state);
  const cache = new MediaCache({ dir: tempDir() });
  const entry = cache.get('a', srv.url);
  await entry.prepare();
  await readAll(entry.stream(0, 10));
  const target = 12;
  const began = Date.now();
  const got = await readAll(entry.stream(target * CHUNK_SIZE, target * CHUNK_SIZE + 99));
  const waited = Date.now() - began;
  assert.deepStrictEqual(got, state.body.subarray(target * CHUNK_SIZE, target * CHUNK_SIZE + 100));
  assert.ok(state.starts.includes(target * CHUNK_SIZE), 'debe pedir el tramo desde el salto');
  assert.ok(waited < 1200, `tardó ${waited} ms; secuencial serían unos 3500 ms`);
  await cache.closeAll();
  await srv.close();
});

test('la caché parcial sobrevive a un reinicio y sirve sin conexión', async () => {
  const state = { body: makeBytes(40 * CHUNK_SIZE) };
  const srv = await startServer(state);
  const dir = tempDir();
  const first = new MediaCache({ dir });
  const e1 = first.get('a', srv.url);
  await e1.prepare();
  await readAll(e1.stream(0, CHUNK_SIZE - 1));
  await Promise.allSettled([...e1.runs]);
  await first.closeAll();
  await srv.close();

  let offline = true;
  const second = new MediaCache({ dir, isOffline: () => offline });
  await second.loadAll();
  const e2 = second.get('a', srv.url);
  assert.ok(e2.ready && !e2.complete);
  assert.deepStrictEqual(await readAll(e2.stream(100, 2000)), state.body.subarray(100, 2001));
  await assert.rejects(readAll(e2.stream(39 * CHUNK_SIZE, 39 * CHUNK_SIZE + 5)), { code: 'OFFLINE' });
  offline = false;
  await second.closeAll();
});

test('el gestor completa el video y la huella coincide', async () => {
  const state = { body: makeBytes(20 * CHUNK_SIZE + 7) };
  const srv = await startServer(state);
  const dir = tempDir();
  const cache = new MediaCache({ dir });
  const persisted = {};
  const dl = new DownloadManager({ cache, resolveUrl: () => srv.url, persisted });
  const done = new Promise((r) => dl.once('done', r));
  dl.start('a');
  await done;
  const entry = cache.get('a', srv.url);
  assert.ok(entry.complete);
  assert.strictEqual(persisted.a.state, 'done');
  await cache.closeAll();
  assert.deepStrictEqual(fs.readFileSync(entry.dataPath), state.body);
  await srv.close();
});

test('funciona con servidores sin soporte de rangos', async () => {
  const state = { body: makeBytes(3 * CHUNK_SIZE + 50), noRanges: true };
  const srv = await startServer(state);
  const cache = new MediaCache({ dir: tempDir() });
  const entry = cache.get('a', srv.url);
  await entry.prepare();
  assert.strictEqual(entry.meta.acceptRanges, false);
  const start = 2 * CHUNK_SIZE;
  assert.deepStrictEqual(await readAll(entry.stream(start, start + 100)), state.body.subarray(start, start + 101));
  await cache.closeAll();
  await srv.close();
});

test('si la fuente cambia no se mezclan versiones', async () => {
  const state = { body: makeBytes(30 * CHUNK_SIZE, 1), etag: '"v1"' };
  const srv = await startServer(state);
  const cache = new MediaCache({ dir: tempDir() });
  const entry = cache.get('a', srv.url);
  await entry.prepare();
  await readAll(entry.stream(0, 100));
  await Promise.allSettled([...entry.runs]);
  state.body = makeBytes(30 * CHUNK_SIZE, 2);
  state.etag = '"v2"';
  await assert.rejects(readAll(entry.stream(25 * CHUNK_SIZE, 25 * CHUNK_SIZE + 10)), { code: 'SOURCE_CHANGED' });
  await Promise.allSettled([...entry.runs]);
  assert.strictEqual(entry.count, 0);
  const out = await readAll(entry.stream(0, 100));
  assert.deepStrictEqual(out, state.body.subarray(0, 101));
  await cache.closeAll();
  await srv.close();
});

function backupFixture(state) {
  const dir = tempDir();
  const folder = tempDir();
  const cache = new MediaCache({ dir });
  const series = { id: 'serie', title: 'Serie: uno/dos?', episodes: [{ id: 'a', number: 1, title: 'Primero', subs: [] }, { id: 'b', number: 2, title: 'Sin terminar', subs: [] }] };
  const catalog = {
    store: { data: { userSeries: [] } },
    episodes: () => series.episodes.map((e) => ({ ...e, series, url: state.url })),
    episode: (id) => {
      const e = series.episodes.find((x) => x.id === id);
      return e ? { ...e, series, url: state.url } : null;
    },
    mergeFromBackup: () => 0,
  };
  const manager = new BackupManager({
    getFolder: () => folder,
    completeFile: (id) => {
      const entry = cache.get(id, state.url);
      return entry.complete ? { path: entry.dataPath, size: entry.meta.size, ext: entry.meta.ext } : null;
    },
    getUserData: () => ({ progress: {}, watchlist: [] }),
    applyUserData: () => {},
    cache,
    subtitles: new Subtitles({ dir: path.join(dir, 'subs') }),
    catalog,
  });
  return { cache, manager, folder, catalog };
}

async function downloadInto(cache, id, url) {
  const dl = new DownloadManager({ cache, resolveUrl: () => url, persisted: {} });
  const done = new Promise((r) => dl.once('done', r));
  dl.start(id);
  await done;
}

test('respaldo: copia lo completo, omite lo parcial y es incremental', async () => {
  const state = { body: makeBytes(3 * CHUNK_SIZE + 9) };
  const srv = await startServer(state);
  const fx = backupFixture({ url: srv.url });
  await downloadInto(fx.cache, 'a', srv.url);

  const report = await fx.manager.run(null);
  assert.deepStrictEqual(report.copied.map((x) => x.id), ['a']);
  assert.deepStrictEqual(report.incomplete.map((x) => x.id), ['b']);

  const manifest = JSON.parse(fs.readFileSync(path.join(fx.folder, MANIFEST), 'utf8'));
  const item = manifest.items.a;
  const copy = fs.readFileSync(path.join(fx.folder, item.file));
  assert.deepStrictEqual(copy, state.body);
  assert.strictEqual(item.sha256, crypto.createHash('sha256').update(state.body).digest('hex'));
  assert.ok(!/[:?]/.test(path.basename(path.dirname(item.file))));
  assert.ok(fx.manager.find('a'));

  const again = await fx.manager.run(['a']);
  assert.deepStrictEqual(again.skipped.map((x) => x.id), ['a']);
  assert.strictEqual(again.copied.length, 0);
  await fx.cache.closeAll();
  await srv.close();
});

test('respaldo: restaurar recupera la caché y detecta daños', async () => {
  const state = { body: makeBytes(2 * CHUNK_SIZE + 3) };
  const srv = await startServer(state);
  const fx = backupFixture({ url: srv.url });
  await downloadInto(fx.cache, 'a', srv.url);
  await fx.manager.run(['a']);

  await fx.cache.remove('a');
  assert.ok(!fx.cache.get('a', srv.url).complete);
  await fx.manager.restore('a');
  const restored = fx.cache.get('a', srv.url);
  assert.ok(restored.complete);
  assert.deepStrictEqual(await readAll(restored.stream(0, state.body.length - 1)), state.body);

  await fx.cache.remove('a');
  const file = fx.manager.find('a').path;
  const damaged = fs.readFileSync(file);
  damaged[10] ^= 0xff;
  fs.writeFileSync(file, damaged);
  await assert.rejects(fx.manager.restore('a'), /dañado/);
  assert.ok(!fs.existsSync(path.join(fx.cache.dir, 'a.json')));
  await fx.cache.closeAll();
  await srv.close();
});

test('un manifiesto alterado no puede salir de la carpeta', async () => {
  const root = tempDir();
  assert.strictEqual(insideFolder(root, '..\\..\\Windows\\win.ini'), null);
  assert.strictEqual(insideFolder(root, '../fuera.mp4'), null);
  assert.strictEqual(insideFolder(root, path.resolve(root, '..', 'x.mp4')), null);
  assert.ok(insideFolder(root, path.join('Serie', '01.mp4')));
  assert.strictEqual(sanitizeSeries({ id: '../x', episodes: [{ id: 'a' }] }), null);
  const s = sanitizeSeries({ id: 'ok', episodes: [{ id: '../../x' }, { id: 'bien', path: 'C:\\secreto.mp4', url: 'file:///C:/x' }] });
  assert.strictEqual(s.episodes.length, 1);
  assert.strictEqual(s.episodes[0].path, null);
  assert.strictEqual(s.episodes[0].url, null);
});

test('nombres válidos en Windows', () => {
  assert.strictEqual(safeName('Re:Zero / Parte 2?'), 'Re Zero Parte 2');
  assert.strictEqual(safeName('CON'), '_CON');
  assert.strictEqual(safeName('fin. '), 'fin');
  assert.strictEqual(safeName('***'), 'sin nombre');
});

test('subtítulos: SRT a VTT y codificación antigua', () => {
  assert.strictEqual(toVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHola\r\n'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHola\n');
  assert.ok(toVtt('WEBVTT\n\nx').startsWith('WEBVTT\n\nx'));
  assert.strictEqual(decodeText(Uint8Array.from([0x61, 0xf1, 0x6f])), 'año');
});

test('lee las pistas de audio y subtítulos que informa ffmpeg', () => {
  const out = parseStreams([
    "Input #0, matroska,webm, from 'ep.mkv':",
    '  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080 (default)',
    '  Stream #0:1(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp (default)',
    '    Metadata:',
    '      title           : English 5.1',
    '  Stream #0:2(spa): Audio: aac (LC), 48000 Hz, stereo, fltp',
    '  Stream #0:3(spa): Subtitle: subrip (default) (forced)',
    '    Metadata:',
    '      title           : Forzados',
    '  Stream #0:4(spa): Subtitle: ass',
    '  Stream #0:5(eng): Subtitle: hdmv_pgs_subtitle',
    'At least one output file must be specified',
  ].join(String.fromCharCode(10)));
  assert.deepStrictEqual(out.audio.map((a) => [a.index, a.lang, a.codec, a.title]), [[1, 'eng', 'eac3', 'English 5.1'], [2, 'spa', 'aac', '']]);
  assert.deepStrictEqual(out.subs.map((s) => [s.index, s.order, s.codec, s.forced, s.title]), [[3, 0, 'subrip', true, 'Forzados'], [4, 1, 'ass', false, ''], [5, 2, 'hdmv_pgs_subtitle', false, '']]);
});
