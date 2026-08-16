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

function testUrl(url, timeoutMs = 700) {
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
function getBody(url, timeoutMs = 800) {
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
      // Probe in parallel and bail fast: on an idle port both checks settle
      // immediately (connection refused), so we spend almost no time before
      // spawning our own instance.
      Promise.all([isHarnessOnPort(port), isPortUp(port)])
        .then(([isHarness, up]) => {
          if (isHarness) {
            // A real Harness instance is already there — reuse it.
            resolvePromise({ url: `http://127.0.0.1:${port}`, child: null })
            return
          }
          // Port taken by something that is not Harness -> let the OS pick a
          // free port (binding a taken one would EADDRINUSE).
          launch(up ? 0 : port)
        })
        .catch(() => launch(port))
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

function createWindow(appOrigin) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#131312',
    autoHideMenuBar: true,
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
    // Allow navigation to our own app origin (app-internal); block anywhere else.
    const allowed = target.startsWith(appOrigin)
    if (!allowed) event.preventDefault()
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

  return win
}

/** Navigate the window to the real app URL once the service is ready. */
function showApp(win, appUrl) {
  if (win.isDestroyed()) return
  const current = win.webContents.getURL()
  if (current !== appUrl) win.loadURL(appUrl)
  win.show()
  win.focus()
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
      label: '开机自启（后台预热服务）',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
      },
    },
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
  const appUrl = `http://127.0.0.1:${port}`
  const atLogin = app.getLoginItemSettings().wasOpenedAtLogin

  if (atLogin) {
    // Autostart: warm the service silently into the tray, no window.
    buildTray()
    try { await startServer(port) } catch (err) {
      console.error('[desktop] failed to start dsh web:', err)
      app.quit()
    }
    return
  }

  // Normal launch: wait for the service, then open the window directly on the
  // app URL. The window appears once the service is ready; no local splash.
  try {
    const { url } = await startServer(port)
    mainWindow = createWindow(appUrl)
    buildTray()
    showApp(mainWindow, url)
  } catch (err) {
    console.error('[desktop] failed to start dsh web:', err)
    app.quit()
  }
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
