# E2E tests (TIN-1645)

End-to-end tests that drive the **real** Agent Studio app and assert on its live
DOM — the top of the test pyramid.

## Why this is set up the way it is

Apple ships no WKWebView WebDriver, so Tauri's official `tauri-driver` does **not**
work on macOS (it supports Linux + Windows only). Instead we use
[`tauri-plugin-webdriver`](https://github.com/Choochmeque/tauri-plugin-webdriver),
which **embeds a W3C WebDriver server inside the app** (port `4445`).
[WebdriverIO](https://webdriver.io) connects to it and drives the webview. This
runs on macOS.

The plugin is behind the Cargo `webdriver` feature, so it is **entirely excluded**
from normal dev and release builds. It only exists when you build for E2E.

## Run it

```bash
npm run e2e
```

This builds the app with `--features webdriver`, brings up the dev server + app,
and runs the specs. A window will open — the tests drive its DOM directly (this is
not screenshot/coordinate automation), so it works unattended.

## Files

- `run.mjs` — the one-command runner (build → launch → run specs → tear down)
- `smoke.mjs` — confirms the app rendered (wordmark present)
- `features.mjs` — drives each shipped shortcut (⌘K ⌘⇧N ⌘, ⌘R ⌘T ⌘D ⌘\\) and
  asserts the right surface appears

## What it has caught

- A panic in `transcript.rs` (naive byte-slice on a multibyte char) that crashed
  the whole app when opening Transcripts — invisible to unit + component tests.
