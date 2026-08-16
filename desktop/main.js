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

// Minimum splash duration so the startup animation is always visible even when
// the service is already warm (a warm open used to skip it entirely).
const MIN_SPLASH_MS = 1400
let splashStartedAt = 0

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

const SPLASH_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:radial-gradient(1200px 700px at 50% 40%, #1a1a1a 0%, #131312 55%, #0f0f0e 100%);color:#e8e8e6;font:14px system-ui,-apple-system,'Segoe UI',sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px}
  .logo{position:relative;width:72px;height:72px}
  .logo .ring{position:absolute;inset:0;border:7px solid rgba(90,134,239,.18);border-top-color:#5a86ef;border-right-color:#86a8f5;border-radius:50%;animation:spin 1.9s cubic-bezier(.45,.05,.45,.95) infinite}
  .logo .core{position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:#5a86ef;box-shadow:0 0 18px rgba(90,134,239,.7);animation:breathe 1.9s ease-in-out infinite}
  .logo .glow{position:absolute;inset:-14px;border-radius:50%;background:radial-gradient(circle,rgba(90,134,239,.22),transparent 68%);animation:fade 2.4s ease-in-out infinite}
  h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.4px;background:linear-gradient(180deg,#ffffff 20%,#b9c6ee 90%);-webkit-background-clip:text;background-clip:text;color:transparent;animation:rise .8s ease-out both}
  .status{margin:0;font-size:12.5px;color:#6f7686;letter-spacing:.3px;animation:rise .9s ease-out .1s both}
  .bar{width:170px;height:3px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden;animation:rise 1s ease-out .15s both}
  .bar i{display:block;height:100%;width:42%;border-radius:2px;background:linear-gradient(90deg,#5a86ef,#86a8f5);box-shadow:0 0 10px rgba(90,134,239,.6);animation:flow 1.3s ease-in-out infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes breathe{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.12);opacity:1}}
  @keyframes fade{0%,100%{opacity:.5}50%{opacity:1}}
  @keyframes flow{0%{margin-left:-42%}100%{margin-left:100%}}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo"><div class="glow"></div><div class="ring"></div><div class="core"></div></div>
    <h1>DeepSeek Harness</h1>
    <p class="status">正在启动本地服务…</p>
    <div class="bar"><i></i></div>
  </div>
</body>
</html>`)}`

function createWindow(appOrigin) {
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
    // Allow navigation to our own app origin (splash -> app, app-internal);
    // block anything pointing elsewhere.
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

  // Show a local splash immediately; navigate to the app once the service is up.
  splashStartedAt = Date.now()
  win.loadURL(SPLASH_HTML)
  return win
}

/** Navigate the window to the real app URL once the service is ready. */
function showApp(win, appUrl) {
  if (win.isDestroyed()) return
  // Always give the splash a readable beat, even when the service is already
  // warm (so the user sees it, not a flash that jumps straight to the app).
  const elapsed = Date.now() - splashStartedAt
  const hold = Math.max(0, MIN_SPLASH_MS - elapsed)
  const go = () => {
    if (win.isDestroyed()) return
    const current = win.webContents.getURL()
    if (current !== appUrl) win.loadURL(appUrl)
    win.show()
    win.focus()
  }
  if (hold > 0) setTimeout(go, hold)
  else go()
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

  // Start the service first so it warms up regardless of how we were launched.
  const serverPromise = startServer(port).catch((err) => {
    console.error('[desktop] failed to start dsh web:', err)
    app.quit()
    return null
  })

  if (atLogin) {
    // Autostart: warm the service silently into the tray, no window.
    buildTray()
    await serverPromise
    return
  }

  // Normal launch: show splash + tray at once, swap to the app on ready.
  mainWindow = createWindow(appUrl)
  buildTray()
  const result = await serverPromise
  if (result && !mainWindow.isDestroyed()) showApp(mainWindow, result.url)
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
