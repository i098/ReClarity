'use strict';
const lib = require('./lib.js');
const path = require('node:path');
function start(electron) {
  const { app, BrowserWindow, ipcMain } = electron;
  ipcMain.handle('app:total', (_e, items, region) => lib.price(items, region));
  ipcMain.handle('app:license', (_e, k) => lib.license(k));
  app.whenReady().then(() => { const w = new BrowserWindow({ width: 800, height: 600 }); w.loadFile(path.join(__dirname, 'index.html')); });
}
module.exports = { start };
if (require.main === module) { try { start(require('electron')); } catch { console.log('no electron'); } }
