mod embeddings;
mod frontmatter;
mod git;
mod hybrid;
mod launcher;
mod links;
mod search;
mod settings;
mod terminal;
mod transcript;

use std::sync::Mutex;

use search::Db;
use settings::MemoryRoot;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
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

      // Spawn the async embedding pass as a background task so FTS5 search
      // is never blocked on network I/O.  If no API key is set, the pass
      // exits immediately without error (BM25-only mode).
      if let Some(api_key) = embeddings::resolve_api_key() {
        // Spawn the embedding pass on a dedicated OS thread with its own
        // tokio single-thread runtime.  rusqlite's Connection is Send but
        // not Sync; giving it its own thread avoids the Send-across-await
        // constraint imposed by tauri's multi-thread runtime.
        let bg_root = root.clone();
        std::thread::spawn(move || {
          let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("embedding runtime");
          rt.block_on(embeddings::index_embeddings(bg_root, api_key));
        });
      } else {
        log::info!("[embeddings] no API key — embedding pass skipped (BM25-only mode)");
      }

      app.manage(Db(Mutex::new(conn)));
      app.manage(MemoryRoot(Mutex::new(root)));
      app.manage(terminal::TerminalState::default());

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      search::search,
      search::create_file,
      settings::get_settings,
      settings::set_settings,
      settings::rebuild_index,
      settings::set_embedding_key,
      settings::embedding_key_status,
      settings::reveal_embedding_key,
      git::git_status,
      git::git_diff,
      launcher::list_prompts,
      launcher::list_skills,
      launcher::read_prompt,
      links::file_links,
      links::link_suggest,
      links::graph_data,
      links::set_ticket_titles,
      frontmatter::suggest_frontmatter,
      frontmatter::audit_frontmatter,
      frontmatter::import_markdown,
      frontmatter::update_frontmatter,
      transcript::list_transcript_projects,
      transcript::list_sessions,
      transcript::get_session,
      transcript::search_transcripts,
      terminal::spawn_agent,
      terminal::terminal_write,
      terminal::terminal_kill,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
