const { app, BrowserWindow, session, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path   = require('path');
const http   = require('http');
const https  = require('https');
const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs');
const { spawn, execSync } = require('child_process');
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');
const localtunnel = require('localtunnel');

let mainWindow   = null;
let httpServer   = null;
const sseClients = new Map();   // clientId -> response
const validTokens = new Set();  // auth tokens
const SERVER_PORT = 8765;
let serverPassword = null;
let activeTunnel = null;          // For localtunnel instance
let activeTunnelProcess = null;   // For cloudflared child_process
let activeTunnelType = null;      // 'lan' | 'cloudflared' | 'localtunnel' | 'custom'
let activeTunnelUrl = null;
let tray         = null;
let trayBalloonShown = false;
let isQuitting   = false;

const userDataPath = app.getPath('userData');
const certPath = path.join(userDataPath, 'cert.pem');
const keyPath = path.join(userDataPath, 'key.pem');

// ─── App Configuration ────────────────────────────────────────────────────────
const configFilePath = path.join(userDataPath, 'config.json');
function loadConfig() {
  try {
    if (fs.existsSync(configFilePath)) {
      return JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
  } catch {}
  return {};
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(cfg, null, 2));
  } catch {}
}

let recordingsDir = loadConfig().recordingsDir || path.join(app.getPath('videos'), 'CamView');
if (!fs.existsSync(recordingsDir)) {
  try {
    fs.mkdirSync(recordingsDir, { recursive: true });
  } catch {}
}

// ─── Network Interfaces & IP ──────────────────────────────────────────────────
function getInterfacesList() {
  const list = [];
  const interfaces = os.networkInterfaces();
  for (const [name, iface] of Object.entries(interfaces)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        list.push({ name, address: net.address });
      }
    }
  }
  return list;
}

function getBestIP(interfacesList) {
  const sorted = [...interfacesList].sort((a, b) => {
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();
    
    const isVirtualA = /virtual|vbox|vmware|wsl|vethernet|host-only|vpn|zerotier|hamachi|npcap/i.test(nameA);
    const isVirtualB = /virtual|vbox|vmware|wsl|vethernet|host-only|vpn|zerotier|hamachi|npcap/i.test(nameB);
    
    if (isVirtualA && !isVirtualB) return 1;
    if (!isVirtualA && isVirtualB) return -1;
    
    const isPhysicalA = /wi-fi|wlan|ethernet|lan|wireless|беспровод/i.test(nameA);
    const isPhysicalB = /wi-fi|wlan|ethernet|lan|wireless|беспровод/i.test(nameB);
    
    if (isPhysicalA && !isPhysicalB) return -1;
    if (!isPhysicalA && isPhysicalB) return 1;
    
    return 0;
  });
  
  return sorted.length > 0 ? sorted[0].address : '127.0.0.1';
}

function getLocalIP() {
  const list = getInterfacesList();
  return getBestIP(list);
}

// ─── SSL Certificate Generation ───────────────────────────────────────────────
function generateSSLCertificate(ipAddress) {
  const attrs = [{ name: 'commonName', value: 'CamView' }];
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' }
  ];
  
  const added = new Set(['127.0.0.1']);
  if (ipAddress && !added.has(ipAddress)) {
    altNames.push({ type: 7, ip: ipAddress });
    added.add(ipAddress);
  }
  
  // Include all current network interface IPv4 addresses so the certificate remains valid on all adapters
  const ifaces = getInterfacesList();
  ifaces.forEach(i => {
    if (i.address && !added.has(i.address)) {
      altNames.push({ type: 7, ip: i.address });
      added.add(i.address);
    }
  });

  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'basicConstraints',
        cA: true
      },
      {
        name: 'subjectAltName',
        altNames: altNames
      }
    ]
  });
  
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  return { cert: pems.cert, key: pems.private };
}

function getSSLCertificate(ipAddress, forceGenerate = false) {
  if (!forceGenerate && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8')
    };
  }
  return generateSSLCertificate(ipAddress);
}

function notifyViewerCount() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('viewer-count', sseClients.size);
}

// ─── HTTP request handler ─────────────────────────────────────────────────────
function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');

  // ── Serve remote viewer page
  if (url.pathname === '/' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'remote.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('remote.html not found');
    }
    return;
  }

  // ── Serve favicon / app icon
  if ((url.pathname === '/icon.png' || url.pathname === '/favicon.ico') && req.method === 'GET') {
    try {
      const iconBuf = fs.readFileSync(path.join(__dirname, 'icon.png'));
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(iconBuf);
    } catch {
      res.writeHead(404); res.end();
    }
    return;
  }

  // ── Serve jsqr.js scanner library
  if (url.pathname === '/jsqr.js' && req.method === 'GET') {
    try {
      const js = fs.readFileSync(path.join(__dirname, 'jsqr.js'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
    } catch {
      res.writeHead(404); res.end('jsqr.js not found');
    }
    return;
  }

  // ── Login: POST /login  { password } → { ok, token }
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d.toString());
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === serverPassword) {
          const token = crypto.randomBytes(24).toString('hex');
          validTokens.add(token);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Неверный пароль' }));
        }
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // ── SSE frame feed: GET /feed?t=TOKEN
  if (url.pathname === '/feed' && req.method === 'GET') {
    const token = url.searchParams.get('t');
    if (!validTokens.has(token)) { res.writeHead(401); res.end('Unauthorized'); return; }

    res.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"hello"}\n\n');

    const cid = crypto.randomBytes(6).toString('hex');
    sseClients.set(cid, res);
    notifyViewerCount();

    req.on('close', () => {
      sseClients.delete(cid);
      notifyViewerCount();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ─── Tray Menu Helper ─────────────────────────────────────────────────────────
function updateTrayMenu() {
  if (!tray) return;
  const isStarted = !!httpServer;
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть CamView', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    {
      label: isStarted ? 'Сервер: Активен' : 'Сервер: Остановлен',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

// ─── Tunnels (Cloudflare, LocalTunnel, Custom) ──────────────────────────────
function findCloudflaredBinary() {
  const candidates = [
    path.join(__dirname, 'bin', 'cloudflared.exe'),
    path.join(app.getPath('userData'), 'bin', 'cloudflared.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const out = execSync('where.exe cloudflared', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const firstLine = out.split(/\r?\n/)[0].trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {}
  return null;
}

function downloadCloudflared(onProgress) {
  return new Promise((resolve, reject) => {
    const targetDir = path.join(app.getPath('userData'), 'bin');
    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) { return reject(e); }
    }
    const dest = path.join(targetDir, 'cloudflared.exe');
    const tempDest = dest + '.tmp';

    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

    function doDownload(downloadUrl) {
      https.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP status ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const fileStream = fs.createWriteStream(tempDest);

        res.on('data', chunk => {
          downloaded += chunk.length;
          const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          if (onProgress) onProgress({ percent, downloaded, total });
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            try {
              if (fs.existsSync(dest)) fs.unlinkSync(dest);
              fs.renameSync(tempDest, dest);
              resolve(dest);
            } catch (err) {
              reject(err);
            }
          });
        });
      }).on('error', err => {
        try { if (fs.existsSync(tempDest)) fs.unlinkSync(tempDest); } catch {}
        reject(err);
      });
    }

    doDownload(url);
  });
}

async function stopTunnel() {
  if (activeTunnel) {
    try {
      if (typeof activeTunnel.stop === 'function') {
        await activeTunnel.stop();
      } else if (typeof activeTunnel.close === 'function') {
        activeTunnel.close();
      }
    } catch {}
    activeTunnel = null;
  }
  if (activeTunnelProcess) {
    try { activeTunnelProcess.kill('SIGKILL'); } catch {}
    activeTunnelProcess = null;
  }
  activeTunnelType = null;
  activeTunnelUrl = null;
}

async function startTunnel(type, options = {}) {
  await stopTunnel();
  const port = options.port || SERVER_PORT;
  const useHttps = options.useHttps || false;

  if (type === 'localtunnel') {
    try {
      const tunnel = await localtunnel({
        port,
        local_https: useHttps,
        allow_invalid_cert: true
      });
      activeTunnel = tunnel;
      activeTunnelType = 'localtunnel';
      activeTunnelUrl = tunnel.url;

      tunnel.on('close', () => {
        if (activeTunnel === tunnel) {
          activeTunnel = null;
          activeTunnelType = null;
          activeTunnelUrl = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tunnel-closed');
          }
        }
      });
      tunnel.on('error', (err) => {
        console.error('LocalTunnel error:', err);
      });

      return { ok: true, url: tunnel.url, type: 'localtunnel' };
    } catch (err) {
      return { ok: false, error: 'Ошибка запуска LocalTunnel: ' + err.message };
    }
  }

  if (type === 'cloudflared') {
    const binPath = findCloudflaredBinary();
    if (!binPath) {
      return { ok: false, error: 'cloudflared_not_found' };
    }

    return new Promise((resolve) => {
      const protocol = useHttps ? 'https' : 'http';
      const args = ['tunnel', '--url', `${protocol}://127.0.0.1:${port}`];
      if (useHttps) {
        args.push('--no-tls-verify');
      }

      let proc;
      try {
        proc = spawn(binPath, args, { windowsHide: true });
      } catch (e) {
        return resolve({ ok: false, error: 'Не удалось запустить cloudflared: ' + e.message });
      }

      activeTunnelProcess = proc;
      activeTunnelType = 'cloudflared';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, error: 'Превышено время ожидания ответа от Cloudflare' });
        }
      }, 30000);

      function parseOutput(data) {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          activeTunnelUrl = match[0];
          resolve({ ok: true, url: activeTunnelUrl, type: 'cloudflared' });
        }
      }

      proc.stdout.on('data', parseOutput);
      proc.stderr.on('data', parseOutput);

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ ok: false, error: 'Ошибка процесса Cloudflare: ' + err.message });
        }
      });

      proc.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ ok: false, error: `Cloudflare tunnel завершился с кодом ${code}` });
        }
        if (activeTunnelProcess === proc) {
          activeTunnelProcess = null;
          activeTunnelType = null;
          activeTunnelUrl = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tunnel-closed');
          }
        }
      });
    });
  }

  if (type === 'pinggy') {
    let customUrl = (options.customUrl || '').trim();
    if (customUrl) {
      if (!/^https?:\/\//i.test(customUrl)) {
        if (options.pinggySuffix && !customUrl.includes('.')) {
          customUrl = customUrl + options.pinggySuffix;
        }
        customUrl = 'https://' + customUrl;
      }
      customUrl = customUrl.replace(/\/+$/, '');
      activeTunnelType = 'pinggy';
      activeTunnelUrl = customUrl;
      return { ok: true, url: customUrl, type: 'pinggy' };
    }

    // Auto-start live Pinggy tunnel via official SDK (@pinggy/pinggy)
    try {
      const { Pinggy } = require('@pinggy/pinggy');
      const pinggyInstance = new Pinggy();
      const pinggyOpts = {
        forwarding: `localhost:${port}`
      };
      if (options.token) {
        pinggyOpts.token = options.token;
      }
      const tunnel = await pinggyInstance.forward(pinggyOpts);
      activeTunnel = tunnel;
      activeTunnelType = 'pinggy';

      const urls = await tunnel.urls();
      let liveUrl = (Array.isArray(urls) && urls.length > 0) ? urls[0] : (typeof urls === 'string' ? urls : null);
      if (Array.isArray(urls)) {
        const httpsUrl = urls.find(u => u.startsWith('https://'));
        if (httpsUrl) liveUrl = httpsUrl;
      }
      if (!liveUrl) {
        await tunnel.stop();
        return { ok: false, error: 'Pinggy не вернул публичный адрес' };
      }
      activeTunnelUrl = liveUrl;

      tunnel.setTunnelDisconnectedCallback(() => {
        if (activeTunnel === tunnel) {
          activeTunnel = null;
          activeTunnelType = null;
          activeTunnelUrl = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tunnel-closed');
          }
        }
      });

      return { ok: true, url: liveUrl, type: 'pinggy' };
    } catch (err) {
      return { ok: false, error: 'Ошибка запуска Pinggy: ' + err.message };
    }
  }

  if (type === 'custom') {
    let customUrl = (options.customUrl || '').trim();
    if (customUrl) {
      if (!/^https?:\/\//i.test(customUrl)) {
        customUrl = 'https://' + customUrl;
      }
      customUrl = customUrl.replace(/\/+$/, '');
      activeTunnelType = 'custom';
      activeTunnelUrl = customUrl;
      return { ok: true, url: customUrl, type: 'custom' };
    } else {
      return { ok: false, error: 'Введите URL для туннеля' };
    }
  }

  return { ok: true, url: null, type: 'lan' };
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────
function startServer(password, useHttps, ipAddress) {
  if (httpServer) return;
  serverPassword = password;
  validTokens.clear();
  
  if (useHttps) {
    const credentials = getSSLCertificate(ipAddress);
    httpServer = https.createServer(credentials, handleRequest);
  } else {
    httpServer = http.createServer(handleRequest);
  }
  
  httpServer.listen(SERVER_PORT, '0.0.0.0');
  updateTrayMenu();
}

function stopServer() {
  sseClients.forEach(r => { try { r.end(); } catch {} });
  sseClients.clear();
  validTokens.clear();
  if (httpServer) { httpServer.close(); httpServer = null; }
  stopTunnel();
  updateTrayMenu();
  notifyViewerCount();
}

// ─── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.handle('srv-start', (_, config) => {
  const password = config.password;
  const useHttps = config.useHttps;
  const ipAddress = config.ipAddress || getLocalIP();
  
  startServer(password, useHttps, ipAddress);
  return { ip: ipAddress, port: SERVER_PORT, useHttps };
});

ipcMain.handle('srv-stop', () => { stopServer(); });

ipcMain.handle('srv-ip', () => getLocalIP());

ipcMain.handle('srv-get-interfaces', () => {
  return getInterfacesList();
});

ipcMain.handle('srv-regen-cert', (_, ipAddress) => {
  generateSSLCertificate(ipAddress);
  return true;
});

ipcMain.handle('srv-check-cert', () => {
  return fs.existsSync(certPath) && fs.existsSync(keyPath);
});

ipcMain.handle('srv-save-file', async (_, { fileType }) => {
  const sourcePath = fileType === 'cert' ? certPath : keyPath;
  if (!fs.existsSync(sourcePath)) {
    throw new Error('Файл не найден. Сначала включите HTTPS.');
  }
  
  const defaultName = fileType === 'cert' ? 'camview-cert.crt' : 'camview-key.pem';
  
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: fileType === 'cert' ? 'Сохранить SSL сертификат' : 'Сохранить приватный ключ SSL',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [
      fileType === 'cert'
        ? { name: 'Certificate Files (*.crt)', extensions: ['crt'] }
        : { name: 'PEM Files (*.pem)', extensions: ['pem'] },
      { name: 'All Files (*.*)', extensions: ['*'] }
    ]
  });
  
  if (!canceled && filePath) {
    fs.copyFileSync(sourcePath, filePath);
    return true;
  }
});
ipcMain.handle('srv-get-record-dir', () => {
  return recordingsDir;
});

ipcMain.handle('srv-select-record-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку для сохранения записей',
    defaultPath: recordingsDir,
    properties: ['openDirectory', 'createDirectory']
  });
  if (!canceled && filePaths.length > 0) {
    recordingsDir = filePaths[0];
    const cfg = loadConfig();
    cfg.recordingsDir = recordingsDir;
    saveConfig(cfg);
    return recordingsDir;
  }
  return null;
});

ipcMain.handle('srv-open-record-dir', async () => {
  try {
    await shell.openPath(recordingsDir);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('srv-save-record', async (_, { filename, buffer }) => {
  try {
    const filePath = path.join(recordingsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('srv-get-config', () => {
  const cfg = loadConfig();
  return {
    password: cfg.password || null,
    useHttps: cfg.useHttps !== undefined ? cfg.useHttps : false,
    ipAddress: cfg.ipAddress || null,
    accessMode: cfg.accessMode || 'lan',
    pinggySubdomain: cfg.pinggySubdomain || '',
    pinggySuffix: cfg.pinggySuffix || '.a.free.pinggy.link',
    customTunnelUrl: cfg.customTunnelUrl || '',
    language: cfg.language || 'ru',
    isDemo: process.argv.includes('--demo')
  };
});

ipcMain.handle('srv-save-config', (_, data) => {
  const cfg = loadConfig();
  Object.assign(cfg, data);
  saveConfig(cfg);
  return true;
});

ipcMain.handle('srv-gen-qrcode', async (_, text) => {
  try {
    return await QRCode.toDataURL(text, {
      margin: 2,
      width: 320,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  } catch (err) {
    throw new Error('QR generation failed: ' + err.message);
  }
});

// Tunnel IPC handlers
ipcMain.handle('srv-start-tunnel', async (_, options) => {
  return await startTunnel(options.type, options);
});

ipcMain.handle('srv-stop-tunnel', async () => {
  await stopTunnel();
  return true;
});

ipcMain.handle('srv-get-tunnel-status', () => {
  return {
    active: !!(activeTunnel || activeTunnelProcess || (activeTunnelType === 'custom' && activeTunnelUrl)),
    type: activeTunnelType,
    url: activeTunnelUrl
  };
});

ipcMain.handle('srv-check-cloudflared', () => {
  return { exists: !!findCloudflaredBinary() };
});

ipcMain.handle('srv-download-cloudflared', async () => {
  try {
    const dest = await downloadCloudflared((progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cf-download-progress', progress);
      }
    });
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Broadcast a camera frame to all SSE clients
ipcMain.handle('srv-frame', (_, data) => {
  if (!httpServer || sseClients.size === 0) return;
  const msg = 'data: ' + JSON.stringify({ type: 'frame', ...data }) + '\n\n';
  const dead = [];
  sseClients.forEach((res, id) => {
    try { res.write(msg); } catch { dead.push(id); }
  });
  dead.forEach(id => sseClients.delete(id));
  if (dead.length) notifyViewerCount();
});

// ─── Window & Tray ────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('CamView — Мультикамерный просмотр');
  
  tray.on('double-click', () => {
    if (mainWindow) mainWindow.show();
  });
  
  updateTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 550,
    title: 'CamView — Просмотр веб-камер',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#08090d',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
    show: false,
  });

  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  if (process.argv.includes('--capture-demo') || process.argv.includes('--demo')) {
    mainWindow.loadFile('index.html', { query: { demo: '1' } });
  } else {
    mainWindow.loadFile('index.html');
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);
  
  // Intercept window close to hide to system tray
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayBalloonShown) {
        tray.displayBalloon({
          title: 'CamView работает в фоне',
          content: 'Приложение свернуто в трей и продолжает трансляцию с камер.',
          iconType: 'info'
        });
        trayBalloonShown = true;
      }
    }
  });

  mainWindow.on('closed', () => {
    stopServer();
    mainWindow = null;
  });
}

async function runDemoCapture() {
  const outDir = path.join(__dirname, 'docs', 'screenshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  console.log('[Capture] Waiting 3.5s for 4 demo cameras to initialize...');
  await sleep(3500);

  // 1. Desktop grid screenshot
  console.log('[Capture] Capturing desktop_grid.png...');
  const gridImg = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'desktop_grid.png'), gridImg.toPNG());
  console.log('[Capture] desktop_grid.png saved.');

  // 2. Network modal screenshot
  console.log('[Capture] Opening network panel and QR modal...');
  await mainWindow.webContents.executeJavaScript(`
    (async () => {
      toggleRemotePanel();
      await startServer();
      showQrModal();
    })().catch(e => console.error(e));
  `);
  await sleep(1500);

  console.log('[Capture] Capturing network_modal.png...');
  const netImg = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'network_modal.png'), netImg.toPNG());
  console.log('[Capture] network_modal.png saved.');

  // Close QR modal and remote panel for full grid view
  await mainWindow.webContents.executeJavaScript(`
    if (typeof hideQrModal === 'function') hideQrModal();
    var rp = document.getElementById('remote-panel');
    if (rp && rp.classList.contains('open') && typeof toggleRemotePanel === 'function') {
      toggleRemotePanel();
    }
  `);
  await sleep(800);

  // 3. Mobile view screenshot
  console.log('[Capture] Capturing mobile_view.png...');
  const mobileWin = new BrowserWindow({
    width: 412,
    height: 840,
    show: false,
    backgroundColor: '#08090d',
    webPreferences: {
      backgroundThrottling: false
    }
  });
  await mobileWin.loadFile('remote.html');
  await sleep(1000);
  const mobImg = await mobileWin.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'mobile_view.png'), mobImg.toPNG());
  console.log('[Capture] mobile_view.png saved.');
  mobileWin.destroy();

  // 4. Record animated GIF (20 frames over ~2.4 seconds)
  console.log('[Capture] Capturing animated demo.gif...');
  const omggif = require('omggif');
  const gifW = 680;
  const gifH = 414;
  const numFrames = 20;
  const gifBuffer = Buffer.alloc(gifW * gifH * (numFrames + 5));
  const gif = new omggif.GifWriter(gifBuffer, gifW, gifH, { loop: 0 });

  function quantizeFrame(bmp, width, height) {
    const bins = new Map();
    for (let i = 0; i < bmp.length; i += 4) {
      const b = bmp[i] & 0xf8;
      const g = bmp[i + 1] & 0xf8;
      const r = bmp[i + 2] & 0xf8;
      const key = (r << 16) | (g << 8) | b;
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    const sorted = Array.from(bins.entries()).sort((a, b) => b[1] - a[1]);
    const palette = [];
    for (let i = 0; i < 256; i++) {
      palette.push(i < sorted.length ? sorted[i][0] : 0);
    }
    const indexed = new Uint8Array(width * height);
    const searchLimit = Math.min(96, sorted.length);
    for (let i = 0, p = 0; i < bmp.length; i += 4, p++) {
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      let bestDist = Infinity;
      let bestIdx = 0;
      for (let c = 0; c < searchLimit; c++) {
        const color = palette[c];
        const dr = r - ((color >> 16) & 0xff);
        const dg = g - ((color >> 8) & 0xff);
        const db = b - (color & 0xff);
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = c;
          if (dist === 0) break;
        }
      }
      indexed[p] = bestIdx;
    }
    return { palette, indexed };
  }

  for (let f = 0; f < numFrames; f++) {
    const frameImg = await mainWindow.webContents.capturePage();
    const resized = frameImg.resize({ width: gifW, height: gifH, quality: 'good' });
    const bmp = resized.toBitmap();
    const { palette, indexed } = quantizeFrame(bmp, gifW, gifH);

    gif.addFrame(0, 0, gifW, gifH, indexed, { palette, delay: 12 });
    await sleep(120);
  }

  const gifLen = gif.end();
  fs.writeFileSync(path.join(outDir, 'demo.gif'), gifBuffer.subarray(0, gifLen));
  console.log(`[Capture] demo.gif saved (${(gifLen / 1024).toFixed(1)} KB).`);

  console.log('[Capture] All screenshots and demo.gif successfully created!');
  isQuitting = true;
  app.exit(0);
}

app.whenReady().then(() => {
  createTray();
  createWindow();
  if (process.argv.includes('--capture-demo')) {
    mainWindow.once('ready-to-show', () => {
      runDemoCapture().catch(e => {
        console.error('[Capture Error]:', e);
        process.exit(1);
      });
    });
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopTunnel();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
