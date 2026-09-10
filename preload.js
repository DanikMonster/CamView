const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camBridge', {
  startServer:      (config)    => ipcRenderer.invoke('srv-start', config),
  stopServer:       ()          => ipcRenderer.invoke('srv-stop'),
  getIP:            ()          => ipcRenderer.invoke('srv-ip'),
  getInterfaces:    ()          => ipcRenderer.invoke('srv-get-interfaces'),
  regenerateCert:   (ipAddress) => ipcRenderer.invoke('srv-regen-cert', ipAddress),
  checkCertExists:  ()          => ipcRenderer.invoke('srv-check-cert'),
  saveCertFile:     (fileType)  => ipcRenderer.invoke('srv-save-file', { fileType }),
  sendFrame:        (data)      => ipcRenderer.invoke('srv-frame', data),
  onViewerCount:    (cb)        => ipcRenderer.on('viewer-count', (_, n) => cb(n)),
  getRecordDir:     ()          => ipcRenderer.invoke('srv-get-record-dir'),
  selectRecordDir:  ()          => ipcRenderer.invoke('srv-select-record-dir'),
  openRecordDir:    ()          => ipcRenderer.invoke('srv-open-record-dir'),
  saveRecord:       (data)      => ipcRenderer.invoke('srv-save-record', data),
  getConfig:        ()          => ipcRenderer.invoke('srv-get-config'),
  saveConfig:       (data)      => ipcRenderer.invoke('srv-save-config', data),
  generateQR:       (text)      => ipcRenderer.invoke('srv-gen-qrcode', text),
});
