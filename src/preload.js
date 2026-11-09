'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (fn) => {
  const listener = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('akari', {
  catalog: call('catalog:get'),
  statusAll: call('status:all'),
  ranges: call('status:ranges'),
  tracks: call('media:tracks'),
  user: call('user:get'),
  setProgress: call('progress:set'),
  clearProgress: call('progress:clear'),
  toggleWatchlist: call('watchlist:toggle'),
  download: call('download:start'),
  pauseDownload: call('download:pause'),
  downloadSeries: call('download:series'),
  removeCached: call('cache:remove'),
  settings: call('settings:get'),
  setSettings: call('settings:set'),
  setOnline: call('net:online'),
  moveCache: call('cache:move'),
  openFolder: call('folder:open'),
  chooseBackupFolder: call('backup:choose'),
  runBackup: call('backup:run'),
  cancelBackup: call('backup:cancel'),
  importBackup: call('backup:import'),
  restoreBackup: call('backup:restore'),
  importFolder: call('library:importFolder'),
  addUrl: call('library:addUrl'),
  removeSeries: call('library:removeSeries'),
  saveThumb: call('thumb:save'),
  searchOnline: call('search:online'),
  cancelSearch: call('search:cancel'),
  onSearchSource: on('search:source'),
  clearWebCache: call('webcache:clear'),
  webShow: call('web:show'),
  webBounds: call('web:bounds'),
  webHide: call('web:hide'),
  webNav: call('web:nav'),
  onWebState: on('web:state'),
  onWebFullscreen: on('web:fullscreen'),
  onStatus: on('status'),
  onStatusRefresh: on('status:refresh'),
  onConnectivity: on('connectivity'),
  onCatalogChanged: on('catalog:changed'),
  onBackupProgress: on('backup:progress'),
});
