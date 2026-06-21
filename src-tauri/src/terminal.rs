//! terminal.rs
//!
//! Spawns agent processes for the launcher via `std::process::Command`, instead
//! of the Tauri shell plugin. The shell plugin gates `Command.create` behind a
//! command scope that can't allowlist arbitrary, user-configured agent commands,
//! so it denied every launch at runtime. Spawning from Rust sidesteps that
//! entirely.
//!
//! Output is streamed to the frontend terminal via the `terminal://output`
//! event; interactive keystrokes come back through `terminal_write`. The child
//! is held in managed state so a new launch (or `terminal_kill`) reaps the prior.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct TerminalState {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnInput {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Briefing bundle written to the child's stdin. The agent's args also carry
    /// the bundle file path; this covers prompt-on-stdin agents too.
    pub bundle: Option<String>,
}

#[derive(Deserialize)]
pub struct WriteInput {
    pub data: String,
}

/// Read a child stream to EOF, emitting each chunk to the terminal. `emit_exit`
/// (set for stdout only, to avoid a double notice) prints a closing line on EOF.
fn stream<R: Read + Send + 'static>(mut reader: R, app: AppHandle, emit_exit: bool) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if emit_exit {
                        let _ = app.emit("terminal://output", "\r\n\x1b[90m[session ended]\x1b[0m\r\n");
                    }
                    break;
                }
                Ok(n) => {
                    let _ = app.emit("terminal://output", String::from_utf8_lossy(&buf[..n]).to_string());
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
pub fn spawn_agent(payload: SpawnInput, app: AppHandle, state: State<'_, TerminalState>) -> Result<(), String> {
    // Reap any previous session.
    if let Some(mut c) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    *state.stdin.lock().map_err(|e| e.to_string())? = None;

    let mut cmd = Command::new(&payload.command);
    cmd.args(&payload.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Empty cwd means "inherit" — setting current_dir("") fails on spawn.
    if !payload.cwd.trim().is_empty() {
        cmd.current_dir(&payload.cwd);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    if let Some(out) = child.stdout.take() {
        stream(out, app.clone(), true);
    }
    if let Some(err) = child.stderr.take() {
        stream(err, app.clone(), false);
    }

    let mut stdin = child.stdin.take();
    if let (Some(si), Some(bundle)) = (stdin.as_mut(), payload.bundle.as_ref()) {
        let _ = si.write_all(bundle.as_bytes());
        let _ = si.write_all(b"\n");
        let _ = si.flush();
    }
    *state.stdin.lock().map_err(|e| e.to_string())? = stdin;
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);
    Ok(())
}

#[tauri::command]
pub fn terminal_write(payload: WriteInput, state: State<'_, TerminalState>) -> Result<(), String> {
    if let Some(si) = state.stdin.lock().map_err(|e| e.to_string())?.as_mut() {
        si.write_all(payload.data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = si.flush();
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, TerminalState>) -> Result<(), String> {
    if let Some(mut c) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    *state.stdin.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
