/**
 * electron-builder configuration for the DeepSeek Harness desktop shell.
 *
 * Driven by `scripts/package.mjs`, which stages a flattened dependency
 * closure first and passes its path in `DSH_ELECTRON_STAGE`. Running
 * electron-builder directly against this file without that staging step
 * produces an app whose plugin tree cannot load.
 *
 * Two settings encode defects in the tooling rather than preferences:
 *
 * `asar: false` — the `afterPack` hook below has to replace the packaged
 * `node_modules` wholesale, and an asar archive cannot be edited in place.
 * Shipping with asar would need the hook to rebuild the archive instead.
 *
 * The `afterPack` replacement itself — electron-builder performs its own
 * semantic dependency walk over `node_modules`, independent of the `files`
 * globs, and that walk does not follow this repo's workspace layout: left to
 * itself it packs a few dozen files and omits `@deepseek-ai/dsh` entirely.
 * The staged tree is already correct and already verified to boot, so the
 * hook discards electron-builder's selection and copies the staged tree over
 * it. `verbatimSymlinks` keeps the staged tree's own internal symlinks
 * pointing where they were resolved to point.
 */
const fs = require('node:fs')
const path = require('node:path')

/** Staging directory produced by scripts/package.mjs. */
const stage = process.env.DSH_ELECTRON_STAGE
if (!stage) throw new Error('electron-builder.config.cjs: DSH_ELECTRON_STAGE is unset; run this build through scripts/package.mjs.')

/** Electron version to package against; the staged tree carries no `electron` devDependency to infer it from. */
const electronVersion = process.env.DSH_ELECTRON_VERSION
if (!electronVersion) throw new Error('electron-builder.config.cjs: DSH_ELECTRON_VERSION is unset; run this build through scripts/package.mjs.')

module.exports = {
  appId: 'ai.deepseek.harness',
  productName: 'DeepSeek Harness',
  copyright: 'DeepSeek',
  electronVersion,
  // The staged tree's dependencies are already installed and already correct;
  // a rebuild here would re-resolve them against the wrong root.
  npmRebuild: false,
  asar: false,
  directories: {
    output: process.env.DSH_ELECTRON_OUT ?? 'dist-packaged',
  },
  files: [
    '**/*',
    '!**/*.map',
    '!**/*.ts',
    '!**/tsconfig*.json',
  ],
  // Kept configured though `asar: false` makes them inert, so that re-enabling
  // asar does not silently ship these two native modules inside the archive
  // where their binaries cannot be dlopen'd.
  asarUnpack: [
    '**/node_modules/node-pty/**',
    '**/node_modules/sharp/**',
    '**/node_modules/@img/**',
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'assets/icon.icns',
    target: [{ target: 'dmg', arch: ['arm64'] }],
  },
  dmg: {
    // The drag-to-install window: the app on the left, a symlink to
    // /Applications on the right, which is the whole convention users read
    // this window by.
    title: 'DeepSeek Harness',
    icon: 'assets/icon.icns',
    window: { width: 540, height: 380 },
    contents: [
      { x: 150, y: 190, type: 'file' },
      { x: 390, y: 190, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    icon: 'assets/icon.ico',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  nsis: {
    // A guided installer rather than the one-click default: the user picks the
    // install location, which a developer tool's users expect to control.
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // Per-user, so installing never needs an administrator prompt.
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DeepSeek Harness',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
  },
  afterPack: async (context) => {
    const resourcesApp = path.join(context.appOutDir, process.platform === 'darwin'
      ? `${context.packager.appInfo.productFilename}.app/Contents/Resources/app`
      : 'resources/app')
    const packed = path.join(resourcesApp, 'node_modules')
    const staged = path.join(stage, 'node_modules')

    fs.rmSync(packed, { recursive: true, force: true })
    fs.cpSync(staged, packed, { recursive: true, verbatimSymlinks: true })
  },
}
