import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { disposeIpc, registerIpc } from './ipc/handlers.js'
import { detectInstalls } from './services/obs-install.js'
import { Supervisor } from './services/supervisor.js'
import { log, errorMessage } from './util/logger.js'
import { BUILD_ID } from '@shared/version.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

/**
 * Boots, loads the UI, then exits with a status code. Used by CI to prove the
 * main process, preload bridge and renderer bundle still work together.
 */
const smokeTest = process.env.OBSFLEET_SMOKE_TEST === '1'

/** Quitting must never hang, even if a service refuses to close. */
const SHUTDOWN_TIMEOUT_MS = 8000

let mainWindow: BrowserWindow | null = null
let supervisor: Supervisor | null = null
let shuttingDown = false
let exitCode = 0

/**
 * Only one copy of the client may run: two would fight over the same
 * workspace file, both try to bind the asset server port, and each would
 * supervise a different half of the fleet.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void main()
}

async function main(): Promise<void> {
  await app.whenReady()

  // First line of every session log: bug reports arrive as a log file, and
  // without the build metadata there is no way to know which commit produced it.
  log.info('main', `OBS Fleet ${BUILD_ID} on ${process.platform}-${process.arch}`)

  supervisor = new Supervisor()

  try {
    await supervisor.start()
  } catch (err) {
    log.error('main', `Supervisor failed to start: ${errorMessage(err)}`)
    dialog.showErrorBox(
      'OBS Fleet could not start',
      `The workspace could not be initialised.\n\n${errorMessage(err)}`
    )
    app.quit()
    return
  }

  createWindow()
  registerIpc(supervisor, () => mainWindow)

  // Detect OBS on first run so the New Instance dialog is usable immediately.
  if (supervisor.store.getInstalls().length === 0) {
    void detectInstallsOnFirstRun()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    title: 'OBS Fleet',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // Built as ESM (.mjs) because the package is type: module. Electron
      // loads an ESM preload only with sandboxing off, hence `sandbox: false`.
      preload: path.join(dirname, '../preload/index.mjs'),
      // The renderer reaches Node only through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (smokeTest) {
    mainWindow.webContents.once('did-finish-load', () => {
      log.info('main', 'Smoke test: renderer loaded successfully')
      app.quit()
    })
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => {
      log.error('main', `Smoke test: renderer failed to load (${code}) ${description}`)
      exitCode = 1
      app.quit()
    })
  }

  // External links open in the operator's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function detectInstallsOnFirstRun(): Promise<void> {
  try {
    const detected = await detectInstalls()
    await supervisor?.store.mergeDetectedInstalls(detected)
  } catch (err) {
    log.warn('main', `First-run OBS detection failed: ${errorMessage(err)}`)
  }
}

/* ------------------------------------------------------------------ */
/* Shutdown                                                            */
/* ------------------------------------------------------------------ */

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Closing the client deliberately leaves the OBS instances running.
 *
 * A production team's instances are frequently on air; quitting the control
 * surface must never take the show down with it. Relaunching the client
 * reconnects to whatever is still up.
 */
app.on('before-quit', (event) => {
  if (shuttingDown || !supervisor) return
  shuttingDown = true
  event.preventDefault()

  // A service that will not close (a socket with a stuck peer, say) must not
  // leave the operator with a window they cannot quit.
  const deadline = setTimeout(() => {
    log.warn('main', 'Shutdown timed out; exiting anyway')
    disposeIpc()
    app.exit(exitCode)
  }, SHUTDOWN_TIMEOUT_MS)

  void supervisor
    .shutdown({ stopInstances: false })
    .catch((err) => log.error('main', `Shutdown error: ${errorMessage(err)}`))
    .finally(() => {
      clearTimeout(deadline)
      disposeIpc()
      app.exit(exitCode)
    })
})

process.on('uncaughtException', (err) => {
  log.error('main', `Uncaught exception: ${errorMessage(err)}`)
})

process.on('unhandledRejection', (reason) => {
  log.error('main', `Unhandled rejection: ${errorMessage(reason)}`)
})
