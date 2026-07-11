mod archive;
mod audit;
mod cli;
mod consistency;
mod continuity;
mod embeddings;
mod frontmatter;
mod git;
mod hybrid;
mod linear;
mod links;
mod local_embed;
mod maintenance;
mod memory_audit;
mod memory_reads;
mod outcomes;
mod reason;
mod salience;
mod search;
mod settings;
mod suggestions;
mod transcript;

use std::sync::Mutex;

use search::Db;
use settings::MemoryRoot;
use tauri::Manager;

/// Cancellation flags for long-running background passes.
pub struct TaskControl {
    pub audit_cancel: std::sync::atomic::AtomicBool,
    pub suggest_cancel: std::sync::atomic::AtomicBool,
}

impl Default for TaskControl {
    fn default() -> Self {
        Self {
            audit_cancel: std::sync::atomic::AtomicBool::new(false),
            suggest_cancel: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Headless write path (TIN-1731): if invoked as `add-memory ...` / `supersede
  // ...`, run that pipeline, print JSON, and exit — the webview never starts.
  // Any other argv falls through to launch the GUI exactly as before.
  cli::maybe_run();

  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::default().build());

  // E2E only: embed a W3C WebDriver server so WebdriverIO can drive the real app
  // (TIN-1645). Behind the `webdriver` feature; absent from normal builds.
  #[cfg(feature = "webdriver")]
  let builder = builder.plugin(tauri_plugin_webdriver::init());

  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Resolve the memory root from persisted settings (falling back to the
      // default) and build the index against it once at startup. The resolved
      // root is held in managed state so search.rs and set_settings stay in
      // sync; the SQLite Connection is held behind a Mutex (rusqlite's
      // Connection is Send but not Sync).
      let root = settings::resolved_memory_root(app.handle());
      let conn = search::init_db(&root)?;
      if let Err(e) = search::build_index(&root, &conn) {
        log::error!("[search] initial index build failed: {e}");
      }

      // Spawn the embedding pass as a background task so FTS5 search is never
      // blocked on it. Default to the bundled local (candle) model — no API key,
      // fully offline (TIN-1690). It runs on a dedicated OS thread with its own
      // single-thread tokio runtime: rusqlite's Connection is Send but not Sync,
      // so giving it its own thread avoids the Send-across-await constraint, and
      // the CPU-bound model inference stays off tauri's shared runtime. If the
      // model can't load, every file is skipped and search stays BM25-only.
      let bg_root = root.clone();
      std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
          .enable_all()
          .build()
          .expect("embedding runtime");
        rt.block_on(embeddings::index_embeddings_local(bg_root));
      });

      // Ambient maintenance worker (TIN-1766). The consistency monitor's
      // contradiction judge is a blocking local-model call; running it inline
      // under the shared `Db` mutex stalled every command (Sessions beachballed
      // for minutes). So the ambient handlers only ENQUEUE changed notes under
      // the lock; this worker drains that queue on its OWN connection — same
      // own-a-connection pattern as the embeddings thread above — so the model
      // work never holds the shared mutex. WAL + busy_timeout keep the two
      // connections from blocking each other.
      let worker_root = root.clone();
      std::thread::spawn(move || {
        let conn = match search::init_db(&worker_root) {
          Ok(c) => c,
          Err(e) => {
            log::error!("[maintenance] worker DB open failed; ambient maintenance disabled: {e}");
            return;
          }
        };
        loop {
          let processed = maintenance::drain_once(&conn).unwrap_or_else(|e| {
            log::warn!("[maintenance] drain failed: {e}");
            0
          });
          // Idle when the queue is empty; keep draining promptly when it is not.
          if processed == 0 {
            std::thread::sleep(std::time::Duration::from_secs(2));
          }
        }
      });

      app.manage(Db(Mutex::new(conn)));
      app.manage(MemoryRoot(Mutex::new(root)));
      app.manage(TaskControl::default());

      // Build the transcript index once at startup, on a background thread (it
      // re-parses any changed .jsonl, and an active session can be tens of MB —
      // far too slow to run inline on a read). The Sessions view reads the cached
      // table instantly and refetches when `transcripts://indexed` fires. (TIN-1769)
      transcript::index_transcripts_bg(app.handle().clone());

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      search::search,
      search::create_file,
      settings::get_settings,
      settings::set_settings,
      settings::set_retention_policy,
      settings::rebuild_index,
      settings::set_embedding_key,
      settings::embedding_key_status,
      settings::reveal_embedding_key,
      settings::set_gemini_key,
      settings::gemini_key_status,
      settings::reveal_gemini_key,
      git::git_status,
      git::git_diff,
      links::file_links,
      links::link_suggest,
      links::graph_data,
      links::set_ticket_titles,
      frontmatter::suggest_frontmatter,
      frontmatter::audit_frontmatter,
      frontmatter::import_markdown,
      frontmatter::update_frontmatter,
      frontmatter::summarize_note,
      frontmatter::suggest_with_confidence,
      frontmatter::suggest_all,
      frontmatter::apply_suggestion,
      frontmatter::apply_suggestions_bulk,
      audit::consistency_audit,
      audit::cancel_audit,
      consistency::seed_consistency,
      consistency::consistency_findings,
      consistency::consistency_status,
      suggestions::all_suggestions,
      suggestions::suggestions_status,
      frontmatter::cancel_suggest,
      continuity::score_memory,
      memory_audit::record_memory_change,
      memory_audit::get_memory_history,
      memory_reads::record_note_open,
      transcript::list_transcript_projects,
      transcript::list_sessions,
      transcript::get_session,
      transcript::session_outcomes,
      transcript::search_transcripts,
      transcript::sessions_by_day,
      transcript::refresh_transcripts,
      archive::archive_status,
      archive::run_retention_cleanup,
      linear::linear_key_status,
      linear::set_linear_key,
      linear::reveal_linear_key,
      linear::list_linear_teams,
      linear::sync_linear,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
