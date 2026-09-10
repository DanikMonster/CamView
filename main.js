const { app, BrowserWindow, session, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path   = require('path');
const http   = require('http');
const https  = require('https');
const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs');
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

let mainWindow   = null;
let httpServer   = null;
const sseClients = new Map();   // clientId -> response
const validTokens = new Set();  // auth tokens
const SERVER_PORT = 8765;
let serverPassword = null;
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

  mainWindow.loadFile('index.html');
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

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
