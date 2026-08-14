#!/usr/bin/env node
/**
 * Packages the DeepSeek Harness desktop shell.
 *
 * The whole reason this script exists rather than a bare `electron-builder`
 * invocation: the Cordis Loader boots by dynamically `import()`ing ~150 bare
 * workspace specifiers, and Electron always runs its main process with
 * `--preserve-symlinks-main`, which cannot resolve them against pnpm's
 * symlink-per-dependency development layout. Packaging must therefore hand
 * Electron a dependency tree whose workspace packages are real directories.
 *
 * Pipeline:
 *   1. `pnpm deploy` the shell into a staging directory. For `workspace:`
 *      dependencies pnpm copies rather than symlinks, which is the property
 *      that matters.
 *   2. Fill the gap `pnpm deploy` leaves. Most cross-plugin references in this
 *      repo are declared as `peerDependencies` satisfied only by whole-
 *      workspace resolution, which single-target deploy resolution cannot
 *      reproduce, so packages the Loader imports go missing. Rather than
 *      pinning a list that would rot, this boots the staged CLI, harvests the
 *      package names Node reports missing, copies those in, and repeats until
 *      the CLI boots. The loader reports every failed entry per attempt, so it
 *      converges in a handful of passes.
 *   3. Run electron-builder over the staged tree.
 *
 * The durable fix for step 2 belongs in the product: either `apps/cli` declares
 * every dynamically imported plugin as a real dependency, or the deploy
 * manifest is generated from the cordis.yml plugin ids that actually say what
 * must be importable. Until then this loop stands in for it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = path.resolve(APP_DIR, '..', '..')
/**
 * Staging directory, deliberately outside the repository.
 *
 * Node resolves a missing package by walking up every ancestor directory's
 * `node_modules`. Staging anywhere under the repo puts the repo's own fully
 * populated `node_modules` on that walk-up path, so the gap-fill probe below
 * would resolve against the developer's install and report a complete tree
 * that is in fact missing packages — a failure that only surfaces once the
 * app is packaged and no longer has the repo above it.
 */
const STAGE_DIR = path.join(tmpdir(), 'dsh-electron-stage')
const OUT_DIR = path.join(APP_DIR, 'dist-packaged')

/** Upper bound on gap-fill passes. Each pass places everything one boot attempt reveals, and a placed package can expose its own dependencies on the next pass, so the count tracks dependency depth rather than package count. */
const MAX_GAP_FILL_PASSES = 25
/** How long a staged-CLI boot probe may run before it is treated as "did not fail, therefore succeeded". */
const BOOT_PROBE_TIMEOUT_MS = 90_000

/**
 * Runs a command to completion, inheriting stdio, and fails the script on a
 * non-zero exit.
 * @param command - executable to run.
 * @param args - arguments passed through unmodified.
 * @param options - extra spawn options merged over the defaults.
 */
function run(command, args, options = {}) {
  // Windows exposes npm-installed launchers (`pnpm`, `electron-builder`) as
  // `.cmd` shims, and Node refuses to execute a batch file without a shell.
  // Only tokens that would otherwise be split are quoted: a quoted command name
  // changes how cmd.exe resolves the shim, and the batch file then reads its
  // own directory as the working directory and looks for its payload in the
  // wrong place.
  const shell = process.platform === 'win32'
  const quote = value => (shell && /[\s&|<>^]/.test(value) ? `"${value}"` : value)
  const result = spawnSync(quote(command), args.map(quote), { stdio: 'inherit', cwd: REPO_ROOT, shell, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? `signal ${result.signal}`}`)
}

/**
 * Indexes every workspace package by its declared npm name.
 *
 * Used to resolve a missing package name reported by Node back to the real
 * source directory to copy. Scans the directory groups the root workspace
 * globs cover; a package outside them cannot be gap-filled and will surface as
 * a non-converging loop rather than a silent omission.
 * @returns map from package name to its absolute source directory.
 */
function indexWorkspacePackages() {
  const roots = [
    ...expand(path.join(REPO_ROOT, 'packages'), 2),
    ...expand(path.join(REPO_ROOT, 'vendor'), 1),
    ...expand(path.join(REPO_ROOT, 'apps'), 1),
    ...expand(path.join(REPO_ROOT, 'native', 'landlock-run', 'packages'), 1),
    path.join(REPO_ROOT, 'native', 'landlock-run'),
  ]
  const index = new Map()
  for (const dir of roots) {
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof name === 'string' && !index.has(name)) index.set(name, dir)
    } catch {
      // A malformed package.json in the workspace is the repo's problem to
      // report, not this packaging script's; skipping keeps the index usable.
    }
  }
  return index
}

/**
 * Lists directories `depth` levels below `base`.
 * @param base - directory to descend from; a missing path yields nothing.
 * @param depth - number of levels to descend.
 * @returns absolute directory paths at that depth.
 */
function expand(base, depth) {
  if (!existsSync(base)) return []
  let level = [base]
  for (let i = 0; i < depth; i += 1) {
    level = level.flatMap(dir => readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => path.join(dir, entry.name)))
  }
  return level
}

/**
 * Finds the staged copy of the CLI's built entry point.
 * @returns absolute path to the staged `bin.js`.
 */
function stagedCliBin() {
  const direct = path.join(STAGE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(direct)) return direct
  throw new Error(`packaging: staged CLI entry not found at ${direct}; the deploy step did not produce the expected layout.`)
}

/**
 * Boots the staged CLI once and reports what it could not import.
 *
 * Success is defined as the host accepting a TCP connection on the port it was
 * given — the same readiness signal the shell itself uses — rather than any
 * particular log line.
 * @param port - port to boot the staged host on.
 * @returns the set of package names Node reported missing; empty on success.
 */
async function probeStagedBoot(port) {
  // Spawned through the Electron binary in Node mode, with the same flag the
  // shell passes, because that is what the packaged app runs the CLI with.
  // Plain Node resolves bare specifiers differently from Electron, which always
  // runs its main process with `--preserve-symlinks-main`; probing with Node
  // would accept a tree the packaged app cannot load.
  const child = spawn(electronExecutable, ['--expose-internals', stagedCliBin(), 'web', '--port', String(port)], {
    cwd: STAGE_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: path.join(STAGE_DIR, '.dsh-probe-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })

  const settled = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve('exited'))),
    waitForPort(port).then(() => 'ready'),
    // unref for the same reason as waitForPort's retry timer: this loses the
    // race on every successful pass and must not keep the script alive.
    new Promise(resolve => setTimeout(() => resolve('timeout'), BOOT_PROBE_TIMEOUT_MS).unref()),
  ])

  child.kill('SIGKILL')

  if (settled === 'ready') return new Set()
  const missing = new Set()
  for (const match of output.matchAll(/Cannot find (?:package|module) '([^']+)'/g)) {
    // Node reports the bare specifier; a deep import names its package root.
    const specifier = match[1]
    const parts = specifier.split('/')
    missing.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
  if (missing.size === 0) {
    throw new Error(`packaging: staged CLI did not become ready (${settled}) and reported no missing packages. Output:\n${output.slice(-4000)}`)
  }
  return missing
}

/**
 * Resolves once a TCP connection to the loopback port succeeds.
 * @param port - port to poll.
 * @returns a promise settling when the port accepts a connection.
 */
function waitForPort(port) {
  return new Promise(resolve => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); resolve() })
      // unref: this poll loses the race whenever the child exits or the probe
      // times out first, and an active retry timer would then hold the event
      // loop open forever and the script would never exit.
      socket.once('error', () => { socket.destroy(); setTimeout(attempt, 300).unref() })
    }
    attempt()
  })
}

/**
 * Copies workspace packages into the staged tree's top-level `node_modules`.
 *
 * Top level is deliberate: Node's resolution walks up every ancestor
 * directory, and the staged root is an ancestor of every nested package, so
 * one copy satisfies every importer.
 * @param names - package names to place.
 * @param index - workspace package index from {@link indexWorkspacePackages}.
 * @returns the names that were placed.
 */
function gapFill(names, index) {
  const placed = []
  for (const name of names) {
    const workspaceSource = index.get(name)
    const source = workspaceSource ?? resolveInstalledPackage(name)
    if (source === undefined) throw new Error(`packaging: ${name} is imported at runtime but was found neither in the workspace nor in the installed dependency tree.`)
    const dest = path.join(STAGE_DIR, 'node_modules', ...name.split('/'))
    if (existsSync(dest)) continue
    mkdirSync(path.dirname(dest), { recursive: true })
    // Workspace packages ship a built `lib`, so their TypeScript inputs are
    // dead weight; a third-party package's own `src` may be what it actually
    // loads, so only `node_modules` is dropped there. Either way a dropped
    // nested dependency reappears as a missing package on the next probe pass
    // and gets placed at the staged root, where the resolution walk-up finds it.
    const pruned = workspaceSource === undefined ? ['node_modules'] : ['node_modules', 'src', 'tests']
    cpSync(source, dest, {
      recursive: true,
      filter: entry => !pruned.includes(path.basename(entry)) || statSync(entry).isFile(),
    })
    placed.push(name)
  }
  return placed
}

/**
 * Locates an installed third-party package's real directory.
 *
 * Tries ordinary resolution from the repo root first, then pnpm's content-
 * addressed store, which is where a transitive dependency lives when nothing
 * at the root depends on it directly.
 * @param name - package name to locate.
 * @returns the package's absolute directory, or undefined when not installed.
 */
function resolveInstalledPackage(name) {
  try {
    return path.dirname(createRequire(path.join(REPO_ROOT, 'package.json')).resolve(`${name}/package.json`))
  } catch {
    // Not resolvable from the root: fall through to the store scan below.
  }
  const store = path.join(REPO_ROOT, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const prefix = `${name.replace('/', '+')}@`
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(prefix)) continue
    const candidate = path.join(store, entry, 'node_modules', ...name.split('/'))
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

// Resolved rather than path-joined: pnpm installs `electron` under the package
// that declares it, not at the workspace root.
const electronPackageJson = createRequire(import.meta.url).resolve('electron/package.json')
const electronDir = path.dirname(electronPackageJson)
const electronVersion = JSON.parse(readFileSync(electronPackageJson, 'utf8')).version

// `path.txt` and `dist/` are written by electron's own postinstall, which
// downloads the platform binary. pnpm does not always run it — on GitHub's
// runners the other build scripts in this workspace run while electron's does
// not — so rather than depending on install-time behaviour, fetch the binary
// here when it is absent. electron's installer is idempotent and exits quickly
// once the download is already cached.
if (!existsSync(path.join(electronDir, 'path.txt'))) {
  console.log('[0/4] fetching the Electron binary (its postinstall did not run)')
  run(process.execPath, [path.join(electronDir, 'install.js')], { cwd: electronDir })
}

/** The Electron executable itself, used to probe the staged tree exactly as the packaged app will run it. */
const electronExecutable = path.join(electronDir, 'dist', readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim())
if (!existsSync(electronExecutable)) throw new Error(`packaging: the Electron binary is missing at ${electronExecutable} even after running its installer.`)

for (const required of [path.join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js'), path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html')]) {
  if (!existsSync(required)) throw new Error(`packaging: ${required} is missing; run \`pnpm run build\` at the repo root first.`)
}

console.log('[1/4] building the shell')
// Invoked directly rather than through `pnpm run build`: pnpm verifies
// workspace dependency freshness before running a script, and a workspace that
// has already been `deploy --prod`-staged reads as stale, at which point pnpm
// runs `install --production` and tries to purge the developer's node_modules.
rmSync(path.join(APP_DIR, 'tsconfig.tsbuildinfo'), { force: true })
run(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', path.join(APP_DIR, 'tsconfig.json')])

console.log('[2/4] staging a flattened dependency closure')
rmSync(STAGE_DIR, { recursive: true, force: true })
run('pnpm', ['--filter', '@deepseek-ai/dsh-electron', 'deploy', STAGE_DIR, '--prod', '--legacy'], {
  // Same reason as above; `deploy` has no non-pnpm equivalent, so the check is
  // disabled explicitly instead of being avoided.
  env: { ...process.env, npm_config_verify_deps_before_run: 'false' },
})

console.log('[3/4] filling the peer-dependency gap')
const index = indexWorkspacePackages()
let pass = 0
for (;;) {
  pass += 1
  if (pass > MAX_GAP_FILL_PASSES) throw new Error(`packaging: gap fill did not converge in ${MAX_GAP_FILL_PASSES} passes.`)
  const missing = await probeStagedBoot(31000 + pass)
  if (missing.size === 0) {
    console.log(`      staged host booted after ${pass - 1} gap-fill pass(es)`)
    break
  }
  const placed = gapFill(missing, index)
  console.log(`      pass ${pass}: placed ${placed.length} package(s)`)
  if (placed.length === 0) throw new Error(`packaging: still missing ${[...missing].join(', ')}, but none could be placed.`)
}

console.log('[4/4] running electron-builder')
rmSync(OUT_DIR, { recursive: true, force: true })
// Run from the staged tree so electron-builder treats it as the project, but
// invoke the binary by resolved path: the staging directory is a deploy output,
// not a workspace member, so `pnpm exec` has no project context there.
// `.cmd` on Windows: the `.bin` directory holds batch shims there, not
// extension-less executables.
const builderBin = path.join(APP_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
if (!existsSync(builderBin)) throw new Error(`packaging: ${builderBin} is missing; run \`pnpm install\` at the repo root first.`)
// Host platform only, deliberately. The staged tree carries whatever native
// binaries `pnpm deploy` resolved for the host, and `sharp` publishes one
// package per platform, so a Windows package staged on macOS would ship no
// Windows `sharp` at all and fail at runtime when an image attachment is
// handled. Windows packages are built on Windows. (`node-pty` is not affected:
// it ships every platform's prebuild in one package.)
const targetFlag = { darwin: '--mac', win32: '--win' }[process.platform]
if (targetFlag === undefined) throw new Error(`packaging: unsupported host platform ${process.platform}; this shell targets macOS and Windows, each built on its own platform.`)
run(builderBin, ['--config', path.join(APP_DIR, 'electron-builder.config.cjs'), targetFlag], {
  cwd: STAGE_DIR,
  env: { ...process.env, DSH_ELECTRON_STAGE: STAGE_DIR, DSH_ELECTRON_OUT: OUT_DIR, DSH_ELECTRON_VERSION: electronVersion },
})

console.log(`\npackaged into ${OUT_DIR}`)
