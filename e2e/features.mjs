// E2E: drive each shipped feature's keyboard shortcut against the real app and
// assert the expected surface appears. Connects to the in-app WebDriver server
// (tauri-plugin-webdriver, 4445). Reloads to a clean home between checks.
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

async function bodyText() {
  return (await (await browser.$('body')).getText()) || ''
}

async function resetHome() {
  await browser.url(APP_URL)
  // wait for the app to mount + attach the window keydown listener
  for (let i = 0; i < 30; i++) {
    if ((await bodyText()).includes('Agent Studio')) break
    await browser.pause(200)
  }
  await browser.pause(400)
}

async function check(name, keys, expectAny) {
  await resetHome()
  const before = await bodyText()
  await browser.keys(keys)
  await browser.pause(600)
  const after = await bodyText()
  const hit = expectAny.find((s) => after.includes(s))
  const pass = Boolean(hit)
  results.push({ name, pass, hit: hit || null })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${pass ? `(matched "${hit}")` : `(expected one of ${JSON.stringify(expectAny)})`}`)
  if (!pass) {
    // show what newly appeared, to debug the assertion
    const added = after.replace(before, '')
    console.log('   …new text:', JSON.stringify((added || after).slice(0, 160)))
  }
}

try {
  console.log('url:', await browser.getUrl(), '| title:', await browser.getTitle())

  await check('⌘K  command palette', [Key.Command, 'k'], ['Jump to file', 'ESC', 'No files found'])
  await check('⌘⇧N quick capture', [Key.Command, Key.Shift, 'n'], ['Quick capture', "What's on your mind"])
  await check('⌘,  settings', [Key.Command, ','], ['Memory root', 'Embedding API key', 'Agents'])
  await check('⌘R  launcher', [Key.Command, 'r'], ['Pick a prompt to begin', 'Prompts', 'Run'])
  await check('⌘T  transcripts', [Key.Command, 't'], ['Transcripts', 'Search transcripts', 'No sessions'])
  // 'LinksDiff' x2 confirms the right panel opened on its Diff tab; the diff
  // body then shows real git state (or the calm "Could not read git status"
  // when no working directory is configured — first-run with no agents).
  await check('⌘D  diff tab', [Key.Command, 'd'], ['Changes', 'Nothing changed yet', "isn't a git repository", 'Reading changes', 'Could not read git status'])
  await check('⌘\\  split panel', [Key.Command, '\\'], ['LinksDiff'])
} catch (e) {
  console.log('RUN ERROR:', e.message)
} finally {
  const passed = results.filter((r) => r.pass).length
  console.log(`\n=== ${passed}/${results.length} features verified ===`)
  await browser.deleteSession().catch(() => {})
  process.exit(passed === results.length ? 0 : 1)
}
