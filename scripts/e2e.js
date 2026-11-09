'use strict';
// Prueba de extremo a extremo con la app real y videos reales de red.
// Uso: node scripts/e2e.js [--art]   (--art guarda además las portadas del catálogo)
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, '.e2e');
const USER_DATA = path.join(WORK, 'data');
const BACKUP = path.join(WORK, 'mi respaldo');
const SHOTS = path.join(WORK, 'shots');
const ART = path.join(ROOT, 'src', 'renderer', 'art');
const makeArt = process.argv.includes('--art');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    executablePath: require('electron'),
    env: { ...process.env, AKARI_USER_DATA: USER_DATA },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { console.log('ERROR DE PÁGINA:', e.message); results.push({ name: `pageerror: ${e.message}`, ok: false }); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('consola:', m.text()); });
  await page.waitForSelector('.hero, .page');
  return { app, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);
const status = (page, id) => page.evaluate((i) => window.akari.statusAll().then((s) => s[i]), id);

// Espera en este proceso: el sondeo de waitForFunction no aguarda a promesas de IPC.
async function waitStatus(page, id, field, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await status(page, id);
    if (s[field]) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Tiempo agotado esperando ${field} en ${id}`);
}

async function waitPlaying(page, minTime = 1.5, timeout = 60000) {
  await page.waitForFunction((t) => {
    const v = document.querySelector('video');
    return v && v.currentTime >= t && !v.paused && v.videoWidth > 0;
  }, minTime, { timeout });
}

async function grabFrame(page, at, outFile, width) {
  const data = await page.evaluate(async ({ at, width }) => {
    const v = document.querySelector('video');
    v.pause();
    await new Promise((res) => { v.addEventListener('seeked', res, { once: true }); v.currentTime = at; });
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round(width * v.videoHeight / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.84);
  }, { at, width });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(data.split(',')[1], 'base64'));
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  let { app, page } = await launch();

  await shot(page, '01-inicio');
  check('Portada visible', await page.locator('.hero h1').isVisible());
  await go(page, '#/serie/sintel');
  await page.waitForSelector('.ep-row');
  await shot(page, '02-serie');

  // 1. Reproducción con red: el video se guarda mientras se ve.
  await go(page, '#/ver/sintel-02');
  await waitPlaying(page);
  check('Reproduce un video remoto (MP4)', true);
  await page.mouse.move(600, 400);
  await shot(page, '03-reproductor');

  // 2. Se completa en segundo plano.
  const s1 = await waitStatus(page, 'sintel-02', 'complete');
  check('Video guardado completo en segundo plano', s1.complete && s1.size > 0, `${s1.size} bytes`);
  const onDisk = fs.statSync(path.join(USER_DATA, 'cache', 'sintel-02.media')).size;
  check('Archivo persistente en la caché', onDisk === s1.size);

  // 3. Respaldo en carpeta (el diálogo nativo se sustituye solo en la prueba).
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, BACKUP);
  await go(page, '#/descargas');
  await page.waitForSelector('.dl-item');
  await shot(page, '04-descargas');
  await page.click('[data-act="backup-choose"]');
  await page.waitForFunction(() => document.querySelector('.row-sub')?.textContent.includes('respaldo'));
  await page.click('[data-act="backup-run"]');
  await waitStatus(page, 'sintel-02', 'backedUp', 60000);
  const manifest = JSON.parse(fs.readFileSync(path.join(BACKUP, 'akari-respaldo.json'), 'utf8'));
  const item = manifest.items['sintel-02'];
  check('Respaldo creado con manifiesto', !!item, item?.file);
  check('Copia de igual tamaño', fs.statSync(path.join(BACKUP, item.file)).size === s1.size);

  // 4. Sin conexión REAL tras reiniciar: toda petición de red de la app falla.
  await app.close();
  ({ app, page } = await launch());
  await app.evaluate(({ session, net }) => {
    session.defaultSession.enableNetworkEmulation({ offline: true });
    const original = net.fetch;
    net.fetch = (url, init) => (/^https?:/.test(String(url)) ? Promise.reject(new Error('sin red (prueba)')) : original(url, init));
  });
  await page.evaluate(() => window.akari.setOnline(false));
  await page.waitForSelector('#net-pill:not([hidden])');
  await go(page, '#/');
  await page.waitForSelector('.page');
  await shot(page, '05-sin-conexion');
  await go(page, '#/ver/sintel-02');
  await waitPlaying(page);
  check('Reproduce guardado SIN conexión y tras reiniciar', true);
  await page.evaluate(() => { document.querySelector('video').currentTime = 40; });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 41, null, { timeout: 15000 });
  check('Salta dentro del video sin conexión', true);

  await go(page, '#/ver/elephants-dream-01');
  await page.waitForSelector('.p-status.card', { timeout: 30000 });
  const msg = await page.textContent('.p-status.card');
  check('Lo no guardado explica por qué no está sin conexión', /conéctate/i.test(msg), msg.trim().slice(0, 70));
  await shot(page, '06-no-disponible');

  // 5. Borrar la caché: el video sigue disponible desde el respaldo; restaurar lo devuelve.
  await page.evaluate(() => window.akari.removeCached('sintel-02'));
  const s2 = await status(page, 'sintel-02');
  check('Caché borrada a petición', !s2.complete && s2.backedUp);
  await go(page, '#/ver/sintel-02');
  await waitPlaying(page);
  check('Reproduce desde la carpeta de respaldo', true);
  await go(page, '#/descargas');
  await page.waitForSelector('[data-act="restore"]');
  await page.click('[data-act="restore"]');
  await waitStatus(page, 'sintel-02', 'complete', 60000);
  check('Restauración verificada desde el respaldo', true);

  await go(page, '#/ajustes');
  await page.waitForSelector('.settings');
  await shot(page, '07-ajustes');
  await app.close();

  // 6. Vuelve la red: el resto de formatos del catálogo y los subtítulos.
  ({ app, page } = await launch());
  const titles = [
    ['sintel-01', 'sintel', 300],
    ['tears-of-steel-01', 'tears-of-steel', 120],
    ['elephants-dream-01', 'elephants-dream', 200],
    ['big-buck-bunny-01', 'big-buck-bunny', 60],
  ];
  await page.evaluate(() => window.akari.setSettings({ autoCache: false }));
  for (const [id, art, at] of titles) {
    await go(page, `#/ver/${id}`);
    try {
      await waitPlaying(page, 0.5, 90000);
      check(`Decodifica ${id}`, true);
      if (id === 'sintel-01') {
        const tracks = await page.evaluate(() => [...document.querySelector('video').textTracks].map((t) => `${t.language}:${t.mode}`));
        check('Subtítulo en español activo', tracks.includes('es:showing'), tracks.join(', '));
        await page.evaluate(() => { document.querySelector('video').currentTime = 108; });
        await page.waitForFunction(() => {
          const t = [...document.querySelector('video').textTracks].find((x) => x.language === 'es');
          return t.activeCues && t.activeCues.length > 0;
        }, null, { timeout: 30000 });
        check('Subtítulo se muestra en su momento', true);
        await page.waitForTimeout(600);
        await shot(page, '08-subtitulos');
      }
      if (makeArt) {
        await grabFrame(page, at, path.join(ART, `${art}-banner.jpg`), 1280);
        await grabFrame(page, at, path.join(ART, `${id}.jpg`), 480);
        await grabFrame(page, at, path.join(ART, `${art}-poster.jpg`), 640);
      }
    } catch (err) {
      const text = await page.textContent('.p-status').catch(() => '');
      check(`Decodifica ${id}`, false, `${err.message.split('\n')[0]} ${text}`);
    }
  }
  if (makeArt) {
    await go(page, '#/ver/sintel-02');
    await waitPlaying(page, 0.5);
    await grabFrame(page, 20, path.join(ART, 'sintel-02.jpg'), 480);
  }
  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('La prueba se detuvo:', err);
  process.exit(1);
});
