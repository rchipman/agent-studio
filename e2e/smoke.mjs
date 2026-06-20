// Minimal E2E smoke: connect to the in-app W3C WebDriver server
// (tauri-plugin-webdriver, port 4445) and confirm the real app rendered.
import { remote } from 'webdriverio'

const browser = await remote({
  hostname: '127.0.0.1',
  port: 4445,
  path: '/',
  capabilities: {},
  logLevel: 'error',
})

let failed = false
try {
  const url = await browser.getUrl()
  const title = await browser.getTitle()
  console.log('url:', url)
  console.log('title:', title)

  const body = await browser.$('body')
  const text = await body.getText()
  console.log('body text (first 240):', JSON.stringify(text.slice(0, 240)))

  if (!text.includes('Agent Studio')) {
    console.log('SMOKE FAIL: "Agent Studio" wordmark not found in body')
    failed = true
  } else {
    console.log('SMOKE PASS: app rendered, wordmark present')
  }
} catch (e) {
  console.log('SMOKE ERROR:', e.message)
  failed = true
} finally {
  await browser.deleteSession().catch(() => {})
}
process.exit(failed ? 1 : 0)
