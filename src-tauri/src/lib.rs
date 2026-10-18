mod commands;
mod ssh;
mod ssh_files;

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
            commands::stop,
            ssh_files::read_ssh_file,
            ssh_files::save_ssh_file,
            ssh_files::restore_ssh_file,
            ssh_files::ssh_hosts,
            ssh_files::resolve_ssh_host,
            ssh_files::known_host_entries,
            ssh_files::find_known_host,
            ssh_files::change_known_hosts
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
