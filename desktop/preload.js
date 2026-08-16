// preload.js — minimal, sandboxed bridge for the DeepSeek Harness desktop shell.
//
// The page is the existing web client and needs almost nothing privileged. We
// expose a tiny surface so the injected "Stop service" affordance can ask the
// main process to stop the background dsh web service and quit the app.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopShell', {
  isDesktopApp: true,
  product: 'DeepSeek Harness',
  /** Ask the main process to stop the service and quit the app. */
  stopService: () => ipcRenderer.send('desktop:stop-service'),
})
