const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  openDb: () => ipcRenderer.invoke('open-db'),
  executeQuery: (sql, params) => ipcRenderer.invoke('execute-query', sql, params),
  exportCsv: (data, filename) => ipcRenderer.invoke('export-csv', data, filename),
  exportXlsx: (data, filename) => ipcRenderer.invoke('export-xlsx', data, filename),
  showDetails: (title, row, config) => ipcRenderer.invoke('show-details', title, row, config),
  login: (login, password) => ipcRenderer.invoke('login', login, password),
  getLookupData: (sql, params) =>
    ipcRenderer.invoke(
        'get-lookup-data',
        sql,
        params || []
    ),
    loadConfig: () =>
    ipcRenderer.invoke(
        'load-config'
    ),

saveConfig: (config) =>
    ipcRenderer.invoke(
        'save-config',
        config
    ),
  getUsers: () => ipcRenderer.invoke('get-users'),
  saveUser: (user) => ipcRenderer.invoke('save-user', user),
  deleteUser: (id) => ipcRenderer.invoke('delete-user', id),
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  readExcel: (filePath) => ipcRenderer.invoke('read-excel', filePath),
  readExcelCell: (filePath, cell) => ipcRenderer.invoke('read-excel-cell', filePath, cell),
});