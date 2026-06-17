const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  openDb: () => ipcRenderer.invoke('open-db'),
  executeQuery: (sql, params) => ipcRenderer.invoke('execute-query', sql, params),
  exportCsv: (data, filename) => ipcRenderer.invoke('export-csv', data, filename),
  exportXlsx: (data, filename) => ipcRenderer.invoke('export-xlsx', data, filename),
  showDetails: (title, data) => ipcRenderer.invoke('show-details', title, data),
  login: (login, password) => ipcRenderer.invoke('login', login, password),
  getLookupData: (sql) =>
    ipcRenderer.invoke(
        'get-lookup-data',
        sql
    ),
});