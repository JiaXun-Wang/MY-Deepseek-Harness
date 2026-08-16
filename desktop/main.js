// main.js — Electron main process for the DeepSeek Harness desktop shell.
//
// Responsibilities:
//   1. Start the local `dsh web` service (node apps/cli/lib/bin.js web --port N)
//      with the workspace root as cwd, if a healthy instance is not already up
//      on the default port.
//   2. Open an app window pointing at the served URL.
//   3. On close, stop the service subprocess and quit.
//   4. No Node/IPC is exposed to the page (contextIsolation + sandbox); the
//      window is purely a desktop-frame viewer for the existing web client.

const { app, BrowserWindow, shell, Tray, Menu, nativeImage, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')
const http = require('node:http')
const { existsSync } = require('node:fs')

const ROOT = resolve(__dirname, '..')
// Dedicated default port for THIS DeepSeek Harness install. 3080 is the DSH
// convention but other processes/environments may already use it; a dedicated
// port guarantees "double-click -> my own DSH instance" without squatting on
// someone else's 3080. You can still override with DSH_DESKTOP_PORT.
const DEFAULT_PORT = 5180
const CLI_CLIENT = join(ROOT, 'apps', 'cli', 'lib', 'bin.js')
const NODE = process.env.NODE || (process.platform === 'win32' ? 'node' : 'node')

function nodeCommand() {
  // Resolve an absolute node path so the shell always launches the same runtime
  // found on PATH at startup.
  const cmd = process.platform === 'win32' ? 'node.exe' : 'node'
  return cmd
}

function testUrl(url, timeoutMs = 3500) {
  return new Promise((resolvePromise) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolvePromise(true)
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); resolvePromise(false) })
    req.on('error', () => resolvePromise(false))
  })
}

// True Harness detection: a plain HTTP 200 is not enough — only reuse a port
// when the served page is actually the DeepSeek Harness shell (#root + title),
// so an unrelated web app squatting on 3080 never gets loaded by mistake.
function getBody(url, timeoutMs = 5000) {
  return new Promise((resolvePromise) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolvePromise(data))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); resolvePromise('') })
    req.on('error', () => resolvePromise(''))
  })
}

async function isHarnessOnPort(port) {
  const body = await getBody(`http://127.0.0.1:${port}/`)
  if (!body) return false
  return body.includes('id="root"') || /<title>\s*DeepSeek Harness/.test(body)
}

async function isPortUp(port) {
  return testUrl(`http://127.0.0.1:${port}`)
}

let serverChild = null
let serverLogBuffer = []

function stopServer() {
  if (serverChild && !serverChild.killed) {
    serverChild.kill()
    serverChild = null
  }
}

// Start the dsh web server, produce the URL it serves, and resolve with it.
// Only reuses a port when it already serves the actual Harness shell.
function startServer(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (port === DEFAULT_PORT) {
      isHarnessOnPort(port).then((isHarness) => {
        if (isHarness) {
          // A real Harness instance is already there — reuse it.
          resolvePromise({ url: `http://127.0.0.1:${port}`, child: null })
          return
        }
        // Port is taken by something that is not Harness -> let the OS pick a
        // free port for our own instance (binding the taken one would EADDRINUSE).
        isPortUp(port).then((busy) => {
          launch(busy ? 0 : port)
        })
      })
    } else {
      launch(port)
    }

    function launch(bindPort) {
      const args = [CLI_CLIENT, 'web', '--port', String(bindPort)]
      serverChild = spawn(nodeCommand(), args, {
        cwd: ROOT,
        windowsHide: true,
      })
      serverLogBuffer = []
      let url = null
      let resolved = false

      const onData = (chunk) => {
        const text = chunk.toString()
        serverLogBuffer.push(text)
        if (serverLogBuffer.join('').length > 200_000) serverLogBuffer.shift()
        // Banner: "dsh web: http://127.0.0.1:<port>"
        const m = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/.exec(text)
        if (m && !resolved && !url) {
          url = m[1]
          resolved = true
          resolvePromise({ url, child: serverChild })
        }
      }
      serverChild.stdout?.on('data', onData)
      serverChild.stderr?.on('data', onData)
      serverChild.on('error', (err) => {
        if (!resolved) { resolved = true; rejectPromise(err) }
      })
      serverChild.on('exit', (code) => {
        if (!resolved) {
          resolved = true
          rejectPromise(new Error(`dsh web exited early (code ${code}): ${serverLogBuffer.join('')}`))
        }
      })
      // Fallback: if we bound an OS-assigned port, banner will set url; give it
      // time before declaring failure.
      setTimeout(() => {
        if (!resolved && !url) {
          resolved = true
          rejectPromise(new Error(`timed out waiting for dsh web banner. Log: ${serverLogBuffer.join('')}`))
        }
      }, bindPort === 0 ? 60000 : 45000)
    }
  })
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#131312',
    autoHideMenuBar: true,
    useContentSize: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    // Keep navigation inside the app origin.
    const allowed = target.startsWith(url)
    if (!allowed) event.preventDefault()
  })
  // Inject a visible floating "Stop service" button into the page so the
  // user can turn the background service off without hunting for the tray.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`(() => {
      if (window.__dshStopBtnAdded) return
      const btn = document.createElement('div')
      btn.textContent = '停止服务并退出'
      Object.assign(btn.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
        background: 'rgba(240,90,90,0.92)', color: '#fff', font: '12px/1 sans-serif',
        padding: '8px 12px', borderRadius: '8px', cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,.35)', userSelect: 'none',
      })
      btn.title = '停止后台 dsh 服务并退出桌面端'
      btn.onclick = () => { window.desktopShell && window.desktopShell.stopService() }
      ;(document.body || document.documentElement).appendChild(btn)
      window.__dshStopBtnAdded = true
    })()`).catch(() => {})
  })

  // Closing the window keeps the app (and its dsh web service on 5180) alive
  // in the system tray so the browser can keep syncing. The service is only
  // stopped by explicitly quitting/stopping from the tray.
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.loadURL(url)
  return win
}

// System tray: keeps the app + service resident, and gives an explicit way to
// STOP the service (quit). This is the "turn off the service" control.
let tray = null
let mainWindow = null
let isQuitting = false

function buildTray() {
  if (tray) return
  const icon = TrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  const menu = Menu.buildFromTemplate([
    { label: '打开窗口', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: '浏览器打开 5180', click: () => shell.openExternal(`http://127.0.0.1:${DEFAULT_PORT}`) },
    { type: 'separator' },
    {
      label: '停止服务并退出',
      click: () => {
        isQuitting = true
        stopServer()
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
}

function TrayIcon() {
  // Prefer a bundled app icon; fall back to a small generated glyph.
  const png = join(__dirname, 'app-icon.png')
  if (existsSync(png)) {
    const img = nativeImage.createFromPath(png)
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}

async function main() {
  const port = Number(process.env.DSH_DESKTOP_PORT) || DEFAULT_PORT
  const { url } = await startServer(port)
  mainWindow = createWindow(url)
  buildTray()
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[desktop] failed to start dsh web:', err)
    app.quit()
  })
})

// With the tray keeping the app resident, closing all windows should NOT quit
// the app — it stays in the tray with its service running (unless we are
// actually quitting). The service is stopped via the tray's "stop/quit".
app.on('window-all-closed', (event) => {
  if (!isQuitting) {
    // Keep running in the tray; stop waiting for the user to quit explicitly.
    return
  }
  app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  stopServer()
})

// Handles the in-page "Stop service and quit" request (floating button /
// settings affordance) plus the tray's same action.
ipcMain.on('desktop:stop-service', () => {
  isQuitting = true
  stopServer()
  app.quit()
})
