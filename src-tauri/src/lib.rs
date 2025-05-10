use log::info;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

mod ssh;

struct SshState {
    session: Arc<RwLock<Option<ssh::Session>>>,
    cancel_token: Arc<RwLock<CancellationToken>>,
}

#[derive(Clone, Serialize)]
struct TransferUpdatePayload {
    send_bytes: u64,
    recv_bytes: u64,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
async fn connect(
    ip: &str,
    port: u16,
    user: &str,
    password: &str,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    let mut ssh_session = state.session.write().await;
    if ssh_session.is_none() {
        info!("Connecting to {}:{}", ip, port);

        *ssh_session = match ssh::Session::connect(user, password, (ip, port)).await {
            Ok(session) => Some(session),
            Err(err) => return Err(format!("Connect Error {}", err).to_string()),
        };

        info!("Connected");
        Ok("Connected".to_string())
    } else {
        Ok("Already Connected".to_string())
    }
}

#[tauri::command]
async fn command(command_str: &str, state: tauri::State<'_, SshState>) -> Result<String, String> {
    let ssh_session = state.session.read().await;
    if ssh_session.is_none() {
        return Err("Please connect first".to_string());
    } else {
        info!("Command {}", command_str);

        return match ssh_session.as_ref().unwrap().call(command_str).await {
            Ok(output) => {
                info!("{}", output);
                Ok(output)
            }
            Err(_error) => Err("Command Error".to_string()),
        };
    }
}

#[tauri::command]
async fn forward(
    local_ip: &str,
    local_port: u16,
    remote_ip: &str,
    remote_port: u16,
    user: &str,
    password: &str,
    state: tauri::State<'_, SshState>,
    app: AppHandle,
) -> Result<(), String> {
    connect(remote_ip, remote_port, user, password, state.clone()).await?;

    info!(
        "Start Forward {}:{} -> {}:{}",
        local_ip, local_port, remote_ip, remote_port
    );

    let send_bytes_vec: Arc<RwLock<Vec<Arc<RwLock<u64>>>>> = Arc::new(RwLock::new(Vec::new()));
    let recv_bytes_vec: Arc<RwLock<Vec<Arc<RwLock<u64>>>>> = Arc::new(RwLock::new(Vec::new()));
    {
        let send_bytes_vec_clone = send_bytes_vec.clone();
        let recv_bytes_vec_clone = recv_bytes_vec.clone();

        async fn sum_values_and_reset(data: &Arc<RwLock<Vec<Arc<RwLock<u64>>>>>) -> u64 {
            let vec_guard = data.read().await;
            let mut total = 0;
            for item in vec_guard.iter() {
                let mut value_guard = item.write().await;
                total += *value_guard;
                *value_guard = 0;
            }
            total
        }

        let app_inner = app.clone();
        let cancel_token = state.cancel_token.clone();
        tokio::spawn(async move {
            let cancel_token_inner = {
                let cancel_token_tmp = cancel_token.read().await;
                cancel_token_tmp.clone()
            };
            loop {
                tokio::select! {
                    _ = cancel_token_inner.cancelled() => {
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        let send_bytes_val = sum_values_and_reset(&send_bytes_vec_clone).await;
                        let recv_bytes_val = sum_values_and_reset(&recv_bytes_vec_clone).await;
                        app_inner.emit("update-transfer-statistic", TransferUpdatePayload {
                            send_bytes: send_bytes_val,
                            recv_bytes: recv_bytes_val,
                        }).unwrap();
                    }
                }
            }
        });
    }

    let listener = match TcpListener::bind((local_ip, local_port)).await {
        Ok(v) => v,
        Err(_e) => return Err("TCP Bind Error".to_string()),
    };

    let remote_addr: SocketAddr = match format!("{}:{}", remote_ip, remote_port).parse() {
        Ok(v) => v,
        Err(_e) => return Err("Parse Remote Address Error".to_string()),
    };

    let session = state.session.clone();
    let cancel_token = state.cancel_token.clone();
    let connect_count = Arc::new(Mutex::new(0));
    tokio::spawn({
        async move {
            let cancel_token_outter = {
                let cancel_token_tmp = cancel_token.read().await;
                cancel_token_tmp.clone()
            };
            let send_bytes_vec_clone = send_bytes_vec.clone();
            let recv_bytes_vec_clone = recv_bytes_vec.clone();
            loop {
                tokio::select! {
                    io_result = listener.accept() => {
                        match io_result {
                            Ok((socket, o_addr)) => {
                                let send_bytes = Arc::new(RwLock::new(0u64));
                                let recv_bytes = Arc::new(RwLock::new(0u64));
                                {
                                    let mut connect_count = connect_count.lock().await;
                                    *connect_count += 1;
                                    app.emit("connect-count-change", *connect_count).unwrap();
                                }
                                let state_inner = session.clone();
                                let app_inner = app.clone();
                                let cancel_token_inner = cancel_token_outter.clone();
                                let connect_count_inner = connect_count.clone();
                                let send_bytes_inner = Arc::clone(&send_bytes);
                                let recv_bytes_inner = Arc::clone(&recv_bytes);
                                {
                                    send_bytes_vec_clone.write().await.push(send_bytes);
                                    recv_bytes_vec_clone.write().await.push(recv_bytes);
                                }
                                tokio::spawn({
                                    async move {
                                        let ssh_session = state_inner.read().await;
                                        match ssh_session
                                                .as_ref()
                                                .unwrap()
                                                .forward(socket, o_addr, remote_addr, cancel_token_inner, send_bytes_inner, recv_bytes_inner).await {
                                                    Ok(_output) => info!("Forward Success"),
                                                    Err(_error) => info!("Forward Failed"),
                                        }
                                        let mut connect_count_inner = connect_count_inner.lock().await;
                                        *connect_count_inner -= 1;
                                        app_inner.emit("connect-count-change", *connect_count_inner).unwrap();
                                    }
                                });
                            },
                            Err(_e) => {
                                info!("TCP Accept Error");
                            },
                        }
                    },
                    _ = cancel_token_outter.cancelled() => {
                        info!("Forward is canceled");
                        break;
                    },
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn stop(state: tauri::State<'_, SshState>) -> Result<(), ()> {
    info!("Start to stop forward");

    let mut cancel_token = state.cancel_token.write().await;
    cancel_token.cancel();
    *cancel_token = CancellationToken::new();

    info!("Check session state");
    let mut ssh_session = state.session.write().await;
    if ssh_session.is_some() {
        info!("Stop SSH Session");
        ssh_session
            .as_mut()
            .unwrap()
            .close()
            .await
            .inspect_err(|err| info!("Close Error: {}", err))
            .map_err(|_err| return ())?;
        *ssh_session = None;
    }
    Ok(())
}

fn is_dev_mode() -> bool {
    cfg!(debug_assertions)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::builder()
        .filter_level(if is_dev_mode() {
            log::LevelFilter::Error
        } else {
            log::LevelFilter::Error
        })
        .try_init()
        .expect("Initialize Logger Error");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SshState {
            session: Arc::new(RwLock::new(None)),
            cancel_token: Arc::new(RwLock::new(CancellationToken::new())),
        })
        .invoke_handler(tauri::generate_handler![connect, command, forward, stop])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
