/**
 * Shell-injected CSS and JS for the frameless title bar (macOS traffic
 * lights / Windows `titleBarOverlay`). Everything in this file is applied
 * from the Electron shell via `webContents.insertCSS` /
 * `webContents.executeJavaScript` — nothing here is a change to
 * `packages/client/`, which stays a browser-reusable package with no
 * knowledge that it might ever run inside a native window frame.
 *
 * Selectors deliberately do NOT hardcode `packages/client`'s CSS Modules
 * class names (`SidebarRoot.module.css` compiles `.logoRow` to something
 * like `_4ks_Aa_logoRow` — a per-build content hash prefix that changes on
 * every rebuild). Attribute substring selectors (`[class*="_logoRow"]`)
 * survive that hash churn because CSS Modules always keeps the authored
 * local name as a literal substring of the generated one. That trick only
 * holds for a local name that is unique across packages/client's CSS
 * Modules — generic names (`root` as a CSS Modules local name, `header`,
 * `handle` as a bare word) are reused by unrelated components and would
 * over-match, so every selector below was checked with a repo-wide grep for
 * its local name before use. `#root` is a different kind of anchor: it is
 * the app's static, hand-authored mount point id (packages/client/web/src
 * boots React into `document.getElementById('root')`), not a CSS Modules
 * class, so it is stable across rebuilds. The `--dsw-specific-sidebar-fill`
 * and `--dsw-alias-bg-base` custom properties referenced below are the
 * app's own theme tokens (packages/client/ui-theme/src/styles/
 * design-platform.css), redefined per light/dark theme by that package;
 * referencing them (rather than reading and copying a resolved color) is
 * what keeps this shell's chrome following the app's live theme with no
 * extra work here. Verified against a real running build via CDP DOM
 * inspection, not guessed.
 * @module @deepseek-ai/dsh-electron/window-chrome
 */

/**
 * Height (px) of the full-width band reserved at the top of the window for
 * the macOS traffic-light cluster / Windows `titleBarOverlay` button row.
 * `packages/client`'s own layout (`AppFrame.module.css`'s `.frame`, mounted
 * at `#root`) is pushed down by this amount so the band is genuinely empty
 * window chrome above the app - the sidebar's own divider line and the
 * app's content start at this band's lower edge in both sidebar states,
 * not just visually underneath an opaque overlay. Also drives the
 * `trafficLightPosition` passed to `BrowserWindow` in main.ts, which must
 * stay visually consistent with this.
 *
 * A dedicated band (rather than floating the traffic lights over the
 * sidebar's own top row) is required because the collapsed sidebar rail is
 * narrower than the traffic-light cluster: at the sidebar's own width the
 * cluster would overflow past the rail's divider line into the main pane,
 * straddling a visible boundary. A band that spans the full window width
 * regardless of sidebar width has no such boundary to straddle.
 */
export const TOP_BAND_HEIGHT_PX = 40

/** Element id for the top band's sidebar-width segment (see {@link TOP_BAND_SPLIT_SCRIPT}). */
const TOP_BAND_SIDEBAR_ID = 'dsh-electron-top-band-sidebar'
/** Element id for the top band's remaining-width segment (see {@link TOP_BAND_SPLIT_SCRIPT}). */
const TOP_BAND_PANE_ID = 'dsh-electron-top-band-pane'

export const WINDOW_CHROME_CSS = `
/* --- Top band: traffic-light / titleBarOverlay clearance ---
 * #root is packages/client/web's React mount point (packages/client/web/src
 * boots into document.getElementById('root')); AppFrame's .frame - the
 * sidebar/main-pane/details grid - is its only child and fills it at
 * height: 100% (packages/client/ui-layout/src/client/AppFrame.module.css).
 * Reserving TOP_BAND_HEIGHT_PX as #root's own padding-top (border-box, so
 * #root's total size is unchanged) shrinks .frame's 100% by the same
 * amount and starts it right below the padding: the sidebar's divider line
 * (.sidebarCol's border-right, AppFrame.module.css) and the main pane both
 * start at TOP_BAND_HEIGHT_PX in both sidebar states, rather than being
 * painted at y:0 and merely covered by an overlay. */
#root {
  box-sizing: border-box;
  padding-top: ${TOP_BAND_HEIGHT_PX}px;
}

/* --- Top band: fill + drag region ---
 * #dsh-electron-top-band-sidebar / -pane are plain elements this shell
 * creates and owns (TOP_BAND_SPLIT_SCRIPT below) - not packages/client
 * output, so their ids are picked by this file and safe to select exactly.
 * Both segments carry one shared fill, a step deeper on the app's own
 * neutral-bluish ramp than either surface below them (the sidebar's fill and
 * the main pane's base sit one and two steps lighter). Reading as its own
 * deliberate band beats approximating either neighbour: a near-match seams
 * visibly wherever it meets the tint it failed to equal, while a clear step
 * reads as window chrome. --dsw-alias-bg-module-platform is the app's own
 * platform-surface token and is redefined per theme, so the band follows
 * light/dark with no resolved color copied here. The split survives because
 * the two segments are still positioned independently: the sidebar
 * segment's width - the only thing the CSS Modules layout doesn't expose as
 * a token (AppFrame.tsx sets it via an inline gridTemplateColumns style,
 * not a custom property) - is kept in sync by TOP_BAND_SPLIT_SCRIPT's
 * ResizeObserver. */
#${TOP_BAND_SIDEBAR_ID},
#${TOP_BAND_PANE_ID} {
  position: fixed;
  top: 0;
  height: ${TOP_BAND_HEIGHT_PX}px;
  z-index: 10;
  -webkit-app-region: drag;
}
#${TOP_BAND_SIDEBAR_ID},
#${TOP_BAND_PANE_ID} {
  background: var(--dsw-alias-bg-module-platform);
}
#${TOP_BAND_SIDEBAR_ID} {
  left: 0;
}
#${TOP_BAND_PANE_ID} {
  right: 0;
}

/* --- Drag region: sidebar top row ---
 * SidebarRoot's .logoRow (packages/client/ui-sidebar/src/client/
 * SidebarRoot.tsx) is the sidebar's own top row, immediately below the top
 * band. It renders at its authored geometry unmodified - the traffic
 * lights live in the band above, not over this row, so it no longer needs
 * extra clearance. Extending it draggable too adds a little more drag area
 * within the sidebar column specifically; every button inside it (the
 * brand/New Session button and the sidebar collapse/expand toggle - both
 * plain <button> elements, see SidebarRoot.tsx) is carved out as
 * non-draggable so they stay clickable. */
[class*="_logoRow"] {
  -webkit-app-region: drag;
}
[class*="_logoRow"] button {
  -webkit-app-region: no-drag;
}

/* --- Drag region guard: sidebar/main-pane resize handle ---
 * AppFrame's .handle (packages/client/ui-layout/src/client/
 * AppFrame.module.css) is an 8px pointer-drag strip straddling the
 * sidebar/main-pane border, used to resize the sidebar column by JS
 * pointer events - unrelated to OS window dragging. It sits a few pixels
 * inside the main pane's left edge, overlapping the sidebar drag region
 * above at that seam; -webkit-app-region: drag firing there instead of the
 * handle's own pointerdown listener would break the resize gesture, so the
 * handle is carved out explicitly. */
[class*="_handle"] {
  -webkit-app-region: no-drag;
}
`

/**
 * Creates the two top-band fill elements (see `WINDOW_CHROME_CSS`) and
 * keeps the sidebar segment's width matched to the live sidebar column via
 * `ResizeObserver` - the sidebar is user-resizable (AppFrame's drag
 * `.handle`) as well as togglable between its collapsed rail and expanded
 * widths, and that live pixel width is not exposed through any CSS custom
 * property this shell can read from a static stylesheet. Idempotent
 * (checks for its own element id first) so a repeat `did-finish-load` never
 * creates duplicates.
 */
export const TOP_BAND_SPLIT_SCRIPT = `(function () {
  var SIDEBAR_ID = ${JSON.stringify(TOP_BAND_SIDEBAR_ID)}
  var PANE_ID = ${JSON.stringify(TOP_BAND_PANE_ID)}
  if (document.getElementById(SIDEBAR_ID)) return

  var sidebarBand = document.createElement('div')
  sidebarBand.id = SIDEBAR_ID
  var paneBand = document.createElement('div')
  paneBand.id = PANE_ID
  document.body.appendChild(sidebarBand)
  document.body.appendChild(paneBand)

  function sidebarCol() {
    return document.querySelector('[class*="_sidebarCol"]')
  }

  function sync() {
    var col = sidebarCol()
    var width = col ? col.getBoundingClientRect().width : 0
    sidebarBand.style.width = width + 'px'
    paneBand.style.left = width + 'px'
  }

  // packages/client mounts asynchronously; #root's first paint can race
  // this script. Retry briefly until the sidebar column exists, then hand
  // off to ResizeObserver for every width change after that (collapse
  // toggle, live drag-resize, or anything else).
  var attempts = 0
  var timer = setInterval(function () {
    var col = sidebarCol()
    attempts += 1
    if (col) {
      clearInterval(timer)
      sync()
      new ResizeObserver(sync).observe(col)
    } else if (attempts > 50) {
      clearInterval(timer)
    }
  }, 100)
})()`
