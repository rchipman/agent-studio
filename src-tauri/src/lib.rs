mod search;

use std::sync::Mutex;

use search::{memory_root, Db};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Open the index DB and build it once at startup. Held in managed state
      // behind a Mutex (rusqlite's Connection is Send but not Sync).
      let root = memory_root();
      let conn = search::init_db(&root)?;
      if let Err(e) = search::build_index(&root, &conn) {
        log::error!("[search] initial index build failed: {e}");
      }
      app.manage(Db(Mutex::new(conn)));

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![search::search, search::create_file])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
