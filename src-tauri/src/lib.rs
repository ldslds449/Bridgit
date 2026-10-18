mod commands;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::builder()
        .filter_level(log::LevelFilter::Error)
        .try_init()
        .expect("Initialize Logger Error");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(commands::SshState::default())
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::command,
            commands::forward,
            commands::stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
