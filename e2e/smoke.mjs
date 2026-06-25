// Minimal E2E smoke: connect to the in-app W3C WebDriver server
// (tauri-plugin-webdriver, port 4445) and confirm the real app rendered.
//
// The WebDriver-enabled debug binary's webview starts on about:blank (no dev-env
// URL injection from the Tauri CLI), so the spec must DRIVE the navigation to the
// dev server itself — same as features.mjs — then poll for the wordmark, since a
// cold dev server can take several seconds to compile the first page.
import { remote } from 'webdriverio'

const APP_URL = 'http://localhost:3002/'

const browser = await remote({
  hostname: '127.0.0.1',
  port: 4445,
  path: '/',
  capabilities: {},
  logLevel: 'error',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Navigate to the app, then poll the live webview until the wordmark renders (or
// we time out). Returns the final {url, title, text} either way so a failure
// prints useful diagnostics.
async function waitForApp(timeoutMs = 30000, intervalMs = 1000) {
  try { await browser.url(APP_URL) } catch {}
  const start = Date.now()
  let last = { url: '', title: '', text: '' }
  while (Date.now() - start < timeoutMs) {
    try {
      const url = await browser.getUrl()
      const title = await browser.getTitle()
      const text = await browser.$('body').then((b) => b.getText())
      last = { url, title, text }
      if (text.includes('Agent Studio')) return { ok: true, ...last }
    } catch {
      // webview/navigation not ready yet — keep polling
    }
    await sleep(intervalMs)
  }
  return { ok: false, ...last }
}

let failed = false
try {
  const r = await waitForApp()
  console.log('url:', r.url)
  console.log('title:', r.title)
  console.log('body text (first 240):', JSON.stringify(r.text.slice(0, 240)))
  if (r.ok) {
    console.log('SMOKE PASS: app rendered, wordmark present')
  } else {
    console.log('SMOKE FAIL: "Agent Studio" wordmark not found in body after polling')
    failed = true
  }
} catch (e) {
  console.log('SMOKE ERROR:', e.message)
  failed = true
} finally {
  await browser.deleteSession().catch(() => {})
}
process.exit(failed ? 1 : 0)
