const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(path.join(__dirname, 'fixture.html'));
  fs.writeFileSync(path.join(root, 'build', 'fixture-pid.txt'), String(process.pid));
  let needsSecondInjection = process.argv.includes('--double-inject');
  const interval = setInterval(async () => {
    try {
      const status = await window.webContents.executeJavaScript('({ active: !!window.Tamler, indicator: !!document.querySelector("[data-tamler-indicator]"), styles: document.querySelectorAll("[data-tamler-plugin]").length })');
      if (status.active) {
        if (needsSecondInjection) {
          needsSecondInjection = false;
          await globalThis.__tamlerMain.dispose();
          fs.writeFileSync(path.join(root, 'build', 'fixture-await-second.txt'), String(process.pid));
          return;
        }
        clearInterval(interval);
        await globalThis.__tamlerMain.upgrade();
        await new Promise(resolve => setTimeout(resolve, 200));
        const upgraded = await window.webContents.executeJavaScript('({ active: !!window.Tamler, indicator: !!document.querySelector("[data-tamler-indicator]"), styles: document.querySelectorAll("[data-tamler-plugin]").length })');
        const net = require('node:net');
        const controlled = await new Promise((resolve, reject) => {
          const socket = net.createConnection(`\\\\.\\pipe\\tamler-${process.pid}`);
          let output = '';
          socket.setEncoding('utf8');
          socket.setTimeout(3000, () => socket.destroy(new Error('Upgraded control pipe unavailable')));
          socket.on('connect', () => socket.write(JSON.stringify({ action: 'status' }) + '\n'));
          socket.on('data', data => { output += data; });
          socket.on('end', () => { try { resolve(JSON.parse(output).ok); } catch (error) { reject(error); } });
          socket.on('error', reject);
        });
        await window.webContents.reload();
        await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
        await new Promise(resolve => setTimeout(resolve, 300));
        const reloaded = await window.webContents.executeJavaScript('({ active: !!window.Tamler, indicator: !!document.querySelector("[data-tamler-indicator]"), styles: document.querySelectorAll("[data-tamler-plugin]").length })');
        await globalThis.__tamlerMain.dispose();
        const disposed = await window.webContents.executeJavaScript('({ active: !!window.Tamler, indicator: !!document.querySelector("[data-tamler-indicator]"), styles: document.querySelectorAll("[data-tamler-plugin]").length })');
        fs.writeFileSync(path.join(root, 'build', 'fixture-result.json'), JSON.stringify({ initial: status, upgraded, controlled, reloaded, disposed }));
        app.quit();
      }
    } catch (error) {
      fs.writeFileSync(path.join(root, 'build', 'fixture-error.txt'), error.stack);
      app.exit(1);
    }
  }, 250);
  setTimeout(() => app.exit(2), 30000).unref();
});
