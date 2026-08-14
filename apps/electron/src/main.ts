/**
 * Electron main process for the dsh desktop shell.
 *
 * Architecture: this process never boots the Cordis host tree itself. It
 * spawns the existing, already-built `dsh web` CLI (`@deepseek-ai/dsh`'s
 * `lib/bin.js`) as a child process, waits for its HTTP server to accept
 * connections, then points a BrowserWindow at it. Everything browser-side
 * (the dsh web GUI) is reused completely unchanged over real loopback HTTP —
 * there is no IPC bridge and no preload script.
 *
 * Packaging config (electron-builder/electron-forge) is out of scope for
 * this file; it would live in a `build`/`forge` block added to
 * apps/electron/package.json plus a packaging script that stages
 * apps/cli/lib, apps/cli/config, and the CLI's full runtime dependency
 * closure (including apps/web/dist) into the packaged app's resources —
 * see the ranked packaging risks in the blueprint this app was built from.
 * @module @deepseek-ai/dsh-electron/main
 */

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'
import { clearRunningHost, reapOrphanedHost, recordRunningHost } from './orphan-host.ts'
import { TOP_BAND_HEIGHT_PX, TOP_BAND_SPLIT_SCRIPT, WINDOW_CHROME_CSS } from './window-chrome.ts'

const require = createRequire(import.meta.url)

/**
 * Packaged icon assets (assets/icon.*, checked into apps/electron - see
 * apps/electron/assets). Resolved relative to this module's own file rather
 * than process.cwd() so it works the same run from src (dev, via a JS/ESM
 * loader) or the built lib/main.js: both sit one directory above `assets`.
 * Packaging config (electron-builder/electron-forge - see the module doc
 * comment above) will point at assets/icon.icns and assets/icon.ico
 * directly for the packaged build's real app icon; this constant only
 * covers wiring an icon in at runtime for unpackaged dev-mode runs (Dock
 * icon on macOS, BrowserWindow icon on Windows).
 */
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

/** How long to poll the child's HTTP server before giving up and erroring out. */
const READY_TIMEOUT_MS = 30_000
/** Delay between readiness probes. */
const READY_POLL_INTERVAL_MS = 250
/** Grace period after SIGTERM before escalating to SIGKILL on shutdown. */
const SHUTDOWN_GRACE_MS = 10_000
/** Marker lines bracketing `env` output so shell startup banners (motd, nvm, etc.) can't be mistaken for variables. */
const SHELL_ENV_DELIMITER = '__DSH_ELECTRON_SHELL_ENV__'

/** The one `dsh web` child process this app manages, if currently running. */
let dshProcess: ChildProcess | undefined
/** The one BrowserWindow this app shows, if currently open. */
let mainWindow: BrowserWindow | undefined
/** Environment resolved once at startup (see {@link resolveEnvironment}), reused by `activate`-triggered reboots. */
let resolvedEnvironment: NodeJS.ProcessEnv | undefined

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Binds a `net` server on port 0 to obtain an OS-assigned free port, then
 * closes it immediately. There is an inherent, unavoidable TOCTOU gap
 * between this close and the child's own `listen()` call — acceptable here
 * because the child is spawned immediately afterward on loopback only.
 * @returns a currently-free TCP port on 127.0.0.1.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('port probe returned no usable address')) })
        return
      }
      probe.close(() => { resolve(address.port) })
    })
  })
}

/**
 * Resolves the built `dsh` CLI entry point via normal package resolution
 * (`@deepseek-ai/dsh`'s own `package.json#bin.dsh`) rather than a relative
 * path, so this keeps working whether apps/electron sees apps/cli through
 * the workspace symlink (dev) or a future packaged resources layout.
 * @returns absolute path to the built `bin.js` — never the tsx source launch.
 */
function resolveCliBinPath(): string {
  const packageJsonPath = require.resolve('@deepseek-ai/dsh/package.json')
  const pkg = require(packageJsonPath) as { bin?: Record<string, string> }
  const relativeBinPath = pkg.bin?.dsh
  if (relativeBinPath === undefined) {
    throw new Error(`"${packageJsonPath}" has no "bin.dsh" entry; cannot locate the built dsh CLI`)
  }
  return path.join(path.dirname(packageJsonPath), relativeBinPath)
}

/**
 * Runs `<shell> -ilc env` and parses the KEY=VALUE lines between two marker
 * lines, so any interactive-login-shell startup noise (motd, version-manager
 * banners, etc.) printed before/after the real `env` output is discarded.
 * @returns the resolved login shell's environment variables.
 */
async function resolveLoginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL ?? '/bin/zsh'
  const command = `echo ${SHELL_ENV_DELIMITER}; env; echo ${SHELL_ENV_DELIMITER}`
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(shell, ['-ilc', command], { timeout: 10_000 }, (error, stdoutResult) => {
      if (error) { reject(error); return }
      resolve(stdoutResult)
    })
  })
  const sections = stdout.split(SHELL_ENV_DELIMITER)
  const body = sections[1]
  if (body === undefined) {
    throw new Error(`could not find the marked env block in "${shell} -ilc env" output`)
  }
  const env: NodeJS.ProcessEnv = {}
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return env
}

/**
 * macOS Dock/Finder problem: an app launched by double-clicking (not from a
 * terminal) does not inherit the user's shell profile — `DEEPSEEK_API_KEY`,
 * a custom `PATH`, `DSH_HOME`, etc. are simply absent from `process.env`.
 * Guarded to packaged darwin builds only: a `pnpm run dev` launch already
 * runs inside a terminal shell with the real environment, so re-deriving it
 * would be redundant (and pay the ~seconds-long shell-spawn cost) every dev run.
 *
 * Failure here is made visible (a dialog, plus a clear console message) but
 * is not fatal: the GUI still boots on the process's existing environment,
 * matching the fact that `dsh web` itself boots without a key (see
 * apps/electron's parent blueprint doc, §6) — only model requests need it.
 * @returns the environment to spawn the `dsh web` child with.
 */
async function resolveEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== 'darwin' || !app.isPackaged) return process.env
  try {
    const loginEnv = await resolveLoginShellEnvironment()
    return { ...process.env, ...loginEnv }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[dsh-electron] failed to import the login shell environment: ${message}`)
    dialog.showErrorBox(
      'dsh could not import your shell environment',
      `DEEPSEEK_API_KEY, a custom PATH, or DSH_HOME set in your shell profile may be missing as a result. The app will continue to start.\n\n${message}`,
    )
    return process.env
  }
}

/** Single HTTP HEAD probe against `url`; resolves `true` only if the server actually answered. */
function probeOnce(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request(url, { method: 'HEAD', timeout: 1_000 }, (response) => {
      response.resume()
      resolve(true)
    })
    request.on('error', () => { resolve(false) })
    request.on('timeout', () => { request.destroy(); resolve(false) })
    request.end()
  })
}

/**
 * Polls `url` by HTTP HEAD until it responds, the child exits early, or
 * `timeoutMs` elapses — deliberately not a stdout readiness regex (see
 * apps/electron's task brief): TCP/HTTP connectability is the actual thing
 * a browser window needs, and is unaffected by unexpected preamble on the
 * child's stdout/stderr.
 * @param url - the loopback URL the child's webserver row should be bound to.
 * @param child - the spawned `dsh web` process; an early exit fails fast.
 * @param timeoutMs - overall budget before giving up.
 * @param intervalMs - delay between probes.
 */
async function waitForServerReady(
  url: string,
  child: ChildProcess,
  timeoutMs = READY_TIMEOUT_MS,
  intervalMs = READY_POLL_INTERVAL_MS,
): Promise<void> {
  let earlyExitCode: number | null | undefined
  const onExit = (code: number | null): void => { earlyExitCode = code }
  child.once('exit', onExit)
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (earlyExitCode !== undefined) {
        throw new Error(`dsh web exited before becoming ready (exit code ${String(earlyExitCode)})`)
      }
      if (await probeOnce(url)) return
      await delay(intervalMs)
    }
    throw new Error(`dsh web did not become ready at ${url} within ${String(timeoutMs)}ms`)
  } finally {
    child.off('exit', onExit)
  }
}

/**
 * Finds a real Node executable on `PATH`, searching both platforms' naming
 * (`node.exe` on win32) — used only to work around the issue documented on
 * {@link resolveSpawnInterpreter}.
 * @returns an absolute path to a Node executable, or `undefined` if none is on `PATH`.
 */
function findSystemNodeExecutable(): string | undefined {
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, executableName)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The interpreter to spawn the CLI with.
 *
 * Electron's own Node integration (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`)
 * is the only interpreter guaranteed to exist in a *packaged* app — no system
 * Node ships with an end-user install — so it remains the fallback here.
 *
 * Discovered while verifying this app against this repo: Electron always runs
 * its main process with `--preserve-symlinks-main`. That flag is hardcoded,
 * not a togglable CLI switch — passing `--no-preserve-symlinks-main` to the
 * same binary had no effect. It breaks the Cordis Loader's dynamic
 * bare-specifier `import()` of workspace plugins against this repo's pnpm
 * workspace layout (non-hoisted, one symlink per dependency): packages a real
 * Node process resolves by walking up from a package's real, symlink-resolved
 * location are no longer found, and `dsh web` fails to boot its plugin tree.
 * A packaged build (flattened resources, no pnpm symlinks — see the deferred
 * packaging note at the top of this file) would very likely not hit this; dev
 * mode, which always has a real system Node available (this repo's own
 * `engines` field requires one to do anything at all), does. So dev spawns a
 * real `node` off `PATH` instead, and only falls back to the Electron-as-Node
 * path once packaged (where this repo's pnpm-symlink layout is not present
 * anyway).
 * @returns the executable path to spawn the CLI with.
 */
function resolveSpawnInterpreter(): string {
  if (!app.isPackaged) {
    const systemNode = findSystemNodeExecutable()
    if (systemNode !== undefined) return systemNode
    console.error('[dsh-electron] no system Node found on PATH in dev mode; falling back to the Electron-as-Node interpreter, which is known to fail against this repo\'s pnpm workspace layout (see resolveSpawnInterpreter)')
  }
  return process.execPath
}

/**
 * Spawns the built `dsh web` CLI on a freshly picked free port and waits
 * for it to accept connections.
 * @param env - environment to spawn the child with (see {@link resolveEnvironment}).
 * @returns the ready loopback URL and the live child process.
 */
async function bootHost(env: NodeJS.ProcessEnv): Promise<{ url: string; child: ChildProcess }> {
  const port = await pickFreePort()
  const cliBinPath = resolveCliBinPath()
  const interpreter = resolveSpawnInterpreter()
  // `node-addon-require-builtin` — the plain-Node fallback cordis-plugin-hmr
  // uses to reach Node internals without `--expose-internals` — is a native
  // N-API addon built against the system Node ABI, and fails to load under
  // Electron's bundled Node even in ELECTRON_RUN_AS_NODE mode. Passing the
  // flag is what HMR falls back to requiring. Omitted when `interpreter` is a
  // real Node binary, where the addon already loads.
  const interpreterArgs = interpreter === process.execPath ? ['--expose-internals'] : []

  const child = spawn(interpreter, [...interpreterArgs, cliBinPath, 'web', '--port', String(port)], {
    // GUESS: an Electron-appropriate stand-in for the CLI's ordinary
    // process.cwd()-as-workspace-root default; a GUI launch has no
    // meaningful project directory to default to, so the in-GUI workspace
    // picker is the real point of workspace selection for this shell.
    cwd: app.getPath('userData'),
    env: {
      ...env,
      // Required so that, when `interpreter` is process.execPath (the
      // Electron binary — see resolveSpawnInterpreter), it runs cliBinPath as
      // a plain Node script instead of launching a second Electron GUI. A
      // no-op when `interpreter` is a real Node binary.
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Forwarded unconditionally (not just on failure) so a packaged app's
  // logs show the child's own boot diagnostics without extra plumbing.
  child.stdout?.on('data', (chunk: Buffer) => { console.log(`[dsh web] ${chunk.toString().replace(/\n$/, '')}`) })
  child.stderr?.on('data', (chunk: Buffer) => { console.error(`[dsh web] ${chunk.toString().replace(/\n$/, '')}`) })

  // Recorded before readiness: a child that dies during boot is still a
  // process this run spawned, and a crash in between would otherwise leave it
  // unaccounted for.
  if (child.pid !== undefined) await recordRunningHost(app.getPath('userData'), { pid: child.pid, bin: cliBinPath })

  const url = `http://127.0.0.1:${String(port)}`
  await waitForServerReady(url, child)
  return { url, child }
}

/**
 * SIGTERM the child, await its exit, SIGKILL after a grace period. Mirrors
 * the CLI's own internal shutdown escalation (`PROCESS_SHUTDOWN_TIMEOUT_MS`
 * = 5s) with headroom so its fiber-disposal cascade gets to finish first.
 */
async function shutdownHost(): Promise<void> {
  const child = dshProcess
  dshProcess = undefined
  if (child === undefined || child.exitCode !== null) return
  const gone = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  child.kill('SIGTERM')
  await Promise.race([gone, delay(SHUTDOWN_GRACE_MS)])
  if (child.exitCode === null) child.kill('SIGKILL')
  await clearRunningHost(app.getPath('userData'))
}

async function createWindow(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { url, child } = await bootHost(env)
    dshProcess = child
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      // Windows: reserve the OS-drawn min/close/maximize cluster as an
      // overlay instead of a full title bar; requires titleBarStyle:'hidden'
      // (not 'hiddenInset', which is macOS-only). The app's light/dark theme
      // is not wired to this color - see the module doc comment.
      ...process.platform === 'win32' && {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#FAFAFA', symbolColor: '#111111', height: 40 },
        icon: path.join(ASSETS_DIR, 'icon.ico'),
      },
      // macOS: hide the title bar but keep the traffic lights, vertically
      // centered (approximately - Electron does not expose the traffic
      // light cluster's own rendered height, so this mirrors the ratio
      // already used for Windows' titleBarOverlay height above) within the
      // full-width top band window-chrome.ts reserves at the top of #root
      // (TOP_BAND_HEIGHT_PX). x is an inset from the window's left edge,
      // unrelated to the band height.
      ...process.platform === 'darwin' && {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 20, y: Math.round(TOP_BAND_HEIGHT_PX / 2) },
      },
    })
    // The dsh web GUI is unaware it might run inside a native window frame
    // (packages/client stays browser-only - see the module doc comment);
    // did-finish-load + insertCSS/executeJavaScript is the shell-side seam
    // that adapts its layout for the frameless title bar without touching
    // that package. A preload script could do the same, but nothing else
    // in this app needs one (no IPC bridge - see the architecture note
    // above), so this is the simpler of the two options the task allowed.
    mainWindow.webContents.on('did-finish-load', () => {
      void mainWindow?.webContents.insertCSS(WINDOW_CHROME_CSS)
      void mainWindow?.webContents.executeJavaScript(TOP_BAND_SPLIT_SCRIPT)
    })
    await mainWindow.loadURL(url)
    mainWindow.show()
    // No packaged .app/.exe to carry an icon in dev - see ASSETS_DIR's doc
    // comment. Windows' Dock-equivalent (taskbar) icon already comes from
    // the BrowserWindow `icon` option above; macOS needs this separate,
    // process-wide call instead (BrowserWindow's `icon` option is a no-op
    // there).
    if (process.platform === 'darwin') app.dock?.setIcon(path.join(ASSETS_DIR, 'icon.png'))
    mainWindow.on('closed', () => { mainWindow = undefined })
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`[dsh-electron] failed to start the dsh web host:\n${message}`)
    dialog.showErrorBox(`${PRODUCT_NAME} failed to start`, message)
    app.quit()
  }
}

/**
 * User-facing application name: the macOS menu-bar and Dock label, and the
 * leaf of `app.getPath('userData')` — which is also the child host's cwd and
 * therefore where a GUI-launched session's data lands. The packaged bundle
 * name comes from `productName` in package.json and must stay identical;
 * changing either one relocates existing users' data.
 */
const PRODUCT_NAME = 'DeepSeek Harness'

// Before any app.getPath call: those resolve against the name.
app.setName(PRODUCT_NAME)

app.whenReady().then(async () => {
  // Before this run spawns its own child, so a previous run's survivor cannot
  // outlive a second launch (and cannot still hold a port or subprocesses).
  const reaped = await reapOrphanedHost(app.getPath('userData'))
  if (reaped !== undefined) console.log(`[dsh-electron] terminated an orphaned dsh web host (pid ${String(reaped)}) left by a previous run`)

  const env = await resolveEnvironment()
  resolvedEnvironment = env
  await createWindow(env)
}).catch((error: unknown) => {
  console.error('[dsh-electron] startup failed:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  void shutdownHost().finally(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})

app.on('before-quit', (event) => {
  if (dshProcess === undefined || dshProcess.exitCode !== null) return
  event.preventDefault()
  void shutdownHost().finally(() => { app.exit(0) })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && resolvedEnvironment !== undefined) {
    void createWindow(resolvedEnvironment)
  }
})
