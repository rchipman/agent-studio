// E2E: verify the terminal renders as a full-height RIGHT-side dock (not a bottom
// panel) against the real app. Drives ⌘J to toggle the dock, then measures the
// live DOM geometry via getBoundingClientRect. Connects to the in-app WebDriver
// server (tauri-plugin-webdriver, 4445). See TIN-1709 / the side-dock merge.
import { remote, Key } from 'webdriverio'

const APP_URL = 'http://localhost:3002/'

const browser = await remote({
  hostname: '127.0.0.1',
  port: 4445,
  path: '/',
  capabilities: {},
  logLevel: 'error',
})

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// Geometry of the dock + the viewport, read live from the page.
//
// NOTE: the dock animates its width with a 0.18s CSS transition. The app window
// under WebDriver is occluded (not foregrounded), and browsers PAUSE CSS
// transitions for occluded windows — so a freshly-toggled dock would otherwise
// be measured mid-animation (stuck near its start width). We disable the
// transition and force a reflow before reading geometry to get the settled box.
async function dockGeom() {
  return browser.execute(() => {
    const el = document.querySelector('[data-testid="terminal-dock"]')
    if (!el) return { present: false }
    el.style.setProperty('transition', 'none', 'important')
    void el.offsetWidth // force synchronous reflow to settle the width
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      present: true,
      open: el.getAttribute('data-open') === 'true',
      rect: { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height },
      vw: window.innerWidth,
      vh: window.innerHeight,
      borderLeft: cs.borderLeftWidth,
    }
  })
}

async function bodyHas(s) {
  return ((await (await browser.$('body')).getText()) || '').includes(s)
}

async function dockOpen() {
  return browser.execute(() => document.querySelector('[data-testid="terminal-dock"]')?.getAttribute('data-open') === 'true')
}

// ⌘J under WebDriver is occasionally dropped; toggle until we reach `want`.
async function toggleDockTo(want, tries = 6) {
  for (let i = 0; i < tries; i++) {
    if ((await dockOpen()) === want) return true
    await browser.keys([Key.Command, 'j'])
    await browser.pause(350)
  }
  return (await dockOpen()) === want
}

try {
  // Land on a clean home and wait for mount (so the ⌘J keydown listener is live).
  await browser.url(APP_URL)
  for (let i = 0; i < 30; i++) {
    if (await bodyHas('Agent Studio')) break
    await browser.pause(200)
  }

  // 1. Dock is mounted but collapsed (width 0) before opening.
  const closed = await dockGeom()
  record('dock mounted', closed.present, closed.present ? '' : '(no [data-testid="terminal-dock"])')
  if (closed.present) {
    record('starts collapsed (width 0)', closed.rect.width < 2, `(width=${Math.round(closed.rect.width)})`)
  }

  // 2. ⌘J opens it.
  const didOpen = await toggleDockTo(true)
  await browser.pause(300)

  const open = await dockGeom()
  if (!didOpen || !open.present || !open.open) {
    record('⌘J opens dock', false, `(open=${open.open})`)
  } else {
    record('⌘J opens dock', true)
    const { rect, vw, vh, borderLeft } = open
    // SIDE dock, not bottom: it's a vertical column docked on the right edge.
    record('has width (is a column)', rect.width > 100, `(width=${Math.round(rect.width)})`)
    record('docked to RIGHT edge', Math.abs(rect.right - vw) <= 2, `(right=${Math.round(rect.right)} vw=${vw})`)
    record('full content height', rect.height >= vh * 0.6, `(height=${Math.round(rect.height)} vh=${vh})`)
    // A side dock is taller than it is wide; a bottom dock would be the reverse.
    record('taller than wide (side, not bottom)', rect.height > rect.width, `(h=${Math.round(rect.height)} w=${Math.round(rect.width)})`)
    record('left hairline border', parseFloat(borderLeft) >= 1, `(borderLeft=${borderLeft})`)
  }

  // 3. ⌘J again closes it (back to collapsed).
  await toggleDockTo(false)
  await browser.pause(300)
  const reclosed = await dockGeom()
  record('⌘J again collapses dock', reclosed.present && reclosed.rect.width < 2, `(width=${Math.round(reclosed.rect?.width ?? -1)})`)
} catch (e) {
  console.log('RUN ERROR:', e.message)
} finally {
  const passed = results.filter((r) => r.pass).length
  console.log(`\n=== ${passed}/${results.length} terminal-dock checks verified ===`)
  await browser.deleteSession().catch(() => {})
  process.exit(passed === results.length ? 0 : 1)
}
