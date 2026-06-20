mod git;
mod launcher;
mod search;
mod settings;

use std::sync::Mutex;

use search::Db;
use settings::MemoryRoot;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::default().build())
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
      app.manage(Db(Mutex::new(conn)));
      app.manage(MemoryRoot(Mutex::new(root)));

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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
