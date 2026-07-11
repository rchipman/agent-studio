// One-command E2E runner: builds the app with the `webdriver` feature, ensures
// the dev server + app are up, then runs the specs against the real app via the
// in-app W3C WebDriver server (tauri-plugin-webdriver, port 4445).
//
//   npm run e2e
//
// macOS note: Apple ships no WKWebView WebDriver, so the official tauri-driver
// does not work here. tauri-plugin-webdriver embeds the server in the app
// instead, which is what makes this run on macOS.
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP_BIN = `${ROOT}src-tauri/target/debug/app`
const owned = []
const cleanup = () => owned.forEach((c) => { try { c.kill('SIGKILL') } catch {} })
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

const up = async (url) => { try { return (await fetch(url)).ok } catch { return false } }
async function waitFor(url, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await up(url)) return true; await sleep(500) }
  return false
}

// 1. Build with the webdriver feature.
console.log('› building (cargo build --features webdriver)…')
execSync('cargo build --features webdriver', { cwd: `${ROOT}src-tauri`, stdio: 'inherit' })

// 2. Dev server (reuse if already running on 3002).
if (await up('http://localhost:3002')) {
  console.log('› dev server already up on 3002, reusing')
} else {
  console.log('› starting dev server…')
  owned.push(spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'ignore' }))
  if (!(await waitFor('http://localhost:3002', 60000))) { console.error('dev server did not start'); process.exit(1) }
}

// 3. App (fresh instance with the embedded WebDriver server).
console.log('› launching app…')
owned.push(spawn(APP_BIN, [], { cwd: ROOT, stdio: 'ignore' }))
if (!(await waitFor('http://127.0.0.1:4445/status', 30000))) { console.error('WebDriver server did not come up'); process.exit(1) }

// 4. Run the specs.
let code = 0
try {
  execSync('node e2e/smoke.mjs && node e2e/features.mjs', { cwd: ROOT, stdio: 'inherit' })
} catch (e) {
  code = e.status || 1
}
cleanup()
process.exit(code)
