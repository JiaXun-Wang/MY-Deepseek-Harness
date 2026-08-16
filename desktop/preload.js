// preload.js — minimal, sandboxed bridge for the DeepSeek Harness desktop shell.
// The page is the existing web client and needs no privileged API; this only
// exposes a read-only descriptor so the renderer could verify it is being
// served by the local desktop host rather than a random site.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktopShell', {
  isDesktopApp: true,
  product: 'DeepSeek Harness',
})
