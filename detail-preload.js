const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('detailAPI', {
  runButton: (payload) => ipcRenderer.invoke('detail-custom-button', payload)
});