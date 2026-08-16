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

const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')
const http = require('node:http')
const { existsSync } = require('node:fs')

const ROOT = resolve(__dirname, '..')
const DEFAULT_PORT = 3080
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
// Reuses a healthy server already on the default port.
function startServer(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    // Already a healthy service on the default port -> reuse.
    if (port === DEFAULT_PORT) {
      isPortUp(port).then((up) => {
        if (up) {
          resolvePromise({ url: `http://127.0.0.1:${port}`, child: null })
          return
        }
        launch(port)
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
  win.on('close', () => stopServer())
  win.loadURL(url)
  return win
}

async function main() {
  const port = Number(process.env.DSH_DESKTOP_PORT) || DEFAULT_PORT
  const { url } = await startServer(port)
  createWindow(url)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('[desktop] failed to start dsh web:', err)
    app.quit()
  })
})

app.on('window-all-closed', () => {
  stopServer()
  app.quit()
})

app.on('before-quit', () => stopServer())
