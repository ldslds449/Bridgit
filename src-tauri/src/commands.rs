use serde::Serialize;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::ssh::{self, ConnectError};

#[derive(Default)]
pub(crate) struct SshState(Mutex<Runtime>);

#[derive(Default)]
struct Runtime {
    session: Option<Arc<ssh::Session>>,
    task: Option<ForwardTask>,
}

struct ForwardTask {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}

impl ForwardTask {
    async fn stop(self) -> Result<(), String> {
        self.cancel.cancel();
        self.handle
            .await
            .map_err(|error| format!("Forward task failed: {error}"))
    }
}

impl Runtime {
    async fn stop(&mut self) -> Result<(), String> {
        let task_result = match self.task.take() {
            Some(task) => task.stop().await,
            None => Ok(()),
        };
        let close_result = match self.session.take() {
            Some(session) => session.close().await.map_err(|error| error.to_string()),
            None => Ok(()),
        };
        task_result.and(close_result)
    }
}

#[derive(Clone, Serialize)]
struct TransferUpdatePayload {
    send_bytes: u64,
    recv_bytes: u64,
}

#[derive(Default)]
struct Traffic {
    send: Arc<AtomicU64>,
    recv: Arc<AtomicU64>,
}

impl Traffic {
    fn sample(&self) -> TransferUpdatePayload {
        TransferUpdatePayload {
            send_bytes: self.send.swap(0, Ordering::Relaxed),
            recv_bytes: self.recv.swap(0, Ordering::Relaxed),
        }
    }
}

#[tauri::command]
pub(crate) async fn connect(
    ip: &str,
    port: u16,
    user: &str,
    password: &str,
    trusted_key: Option<String>,
    state: tauri::State<'_, SshState>,
    app: AppHandle,
) -> Result<String, ConnectError> {
    let mut runtime = state.0.lock().await;
    if runtime
        .task
        .as_ref()
        .is_some_and(|task| !task.handle.is_finished())
    {
        return Err(ConnectError::message("Stop forwarding before connecting"));
    }
    runtime.stop().await.map_err(ConnectError::message)?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| ConnectError::message(error.to_string()))?
        .join("known_hosts");
    let session = ssh::Session::connect(user, password, (ip, port), path, trusted_key).await?;
    runtime.session = Some(Arc::new(session));
    Ok("Connected".into())
}

#[tauri::command]
pub(crate) async fn command(
    command_str: &str,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    let session = state
        .0
        .lock()
        .await
        .session
        .clone()
        .ok_or("Please connect first")?;
    session
        .call(command_str)
        .await
        .map_err(|error| format!("Command Error: {error}"))
}

#[tauri::command]
pub(crate) async fn forward(
    local_ip: &str,
    local_port: u16,
    remote_ip: &str,
    remote_port: u16,
    user: &str,
    password: &str,
    trusted_key: Option<String>,
    state: tauri::State<'_, SshState>,
    app: AppHandle,
) -> Result<(), ConnectError> {
    let mut runtime = state.0.lock().await;
    if runtime
        .task
        .as_ref()
        .is_some_and(|task| !task.handle.is_finished())
    {
        return Err(ConnectError::message("Forward already in progress"));
    }
    runtime.stop().await.map_err(ConnectError::message)?;
    let remote_addr: SocketAddr = format!("{remote_ip}:{remote_port}")
        .parse()
        .map_err(|error| ConnectError::message(format!("Invalid remote address: {error}")))?;
    if remote_port == 0 || user.is_empty() || password.is_empty() {
        return Err(ConnectError::message(
            "Remote port, user and password are required",
        ));
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| ConnectError::message(error.to_string()))?
        .join("known_hosts");
    let (listener, session) = prepare_forward(
        (local_ip, local_port),
        (remote_ip, remote_port),
        user,
        password,
        path,
        trusted_key,
    )
    .await?;
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(run_forward(
        listener,
        session.clone(),
        remote_addr,
        cancel.clone(),
        app,
    ));
    runtime.session = Some(session);
    runtime.task = Some(ForwardTask { cancel, handle });
    Ok(())
}

pub(crate) async fn prepare_forward(
    local: (&str, u16),
    remote: (&str, u16),
    user: &str,
    password: &str,
    known_hosts: PathBuf,
    trusted_key: Option<String>,
) -> Result<(TcpListener, Arc<ssh::Session>), ConnectError> {
    let listener = TcpListener::bind(local)
        .await
        .map_err(|error| ConnectError::message(format!("TCP Bind Error: {error}")))?;
    let session =
        Arc::new(ssh::Session::connect(user, password, remote, known_hosts, trusted_key).await?);
    Ok((listener, session))
}

async fn run_forward(
    listener: TcpListener,
    session: Arc<ssh::Session>,
    remote_addr: SocketAddr,
    cancel: CancellationToken,
    app: AppHandle,
) {
    let traffic = Traffic::default();
    let mut connections = JoinSet::new();
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    let _ = app.emit("connect-count-change", 0usize);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            result = connections.join_next(), if !connections.is_empty() => {
                match result {
                    Some(Ok(Err(error))) => { let _ = app.emit("tunnel-error", error); }
                    Some(Err(error)) => { let _ = app.emit("tunnel-error", error.to_string()); }
                    _ => {}
                }
                let _ = app.emit("connect-count-change", connections.len());
            }
            _ = interval.tick() => {
                let _ = app.emit("update-transfer-statistic", traffic.sample());
                if session.is_closed() {
                    let _ = app.emit("tunnel-error", "SSH connection closed");
                    break;
                }
            }
            result = listener.accept() => {
                match result {
                    Ok((socket, origin)) => {
                        let session = session.clone();
                        let send = traffic.send.clone();
                        let recv = traffic.recv.clone();
                        connections.spawn(async move {
                            session.forward(socket, origin, remote_addr, send, recv).await.map_err(|error| error.to_string())
                        });
                        let _ = app.emit("connect-count-change", connections.len());
                    }
                    Err(error) => {
                        let _ = app.emit("tunnel-error", format!("TCP Accept Error: {error}"));
                        break;
                    }
                }
            }
        }
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    let _ = app.emit("update-transfer-statistic", traffic.sample());
    let _ = app.emit("connect-count-change", 0usize);
    let _ = app.emit("forward-stopped", ());
}

#[tauri::command]
pub(crate) async fn stop(state: tauri::State<'_, SshState>) -> Result<(), String> {
    state.0.lock().await.stop().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stop_waits_for_listener_release_before_restart() {
        for _ in 0..3 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            assert!(TcpListener::bind(address).await.is_err());
            let cancel = CancellationToken::new();
            let worker_cancel = cancel.clone();
            let handle = tokio::spawn(async move {
                worker_cancel.cancelled().await;
                drop(listener);
            });
            let mut runtime = Runtime {
                session: None,
                task: Some(ForwardTask { cancel, handle }),
            };
            runtime.stop().await.unwrap();
            assert!(runtime.task.is_none());
            let retry = TcpListener::bind(address).await.unwrap();
            drop(retry);
            runtime.stop().await.unwrap();
        }
    }

    #[tokio::test]
    async fn startup_errors_release_the_port_and_allow_retry() {
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = occupied.local_addr().unwrap();
        let remote = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_port = remote.local_addr().unwrap().port();
        drop(remote);
        let path = std::env::temp_dir().join("ssh-gui-unused-known-hosts");
        let error = prepare_forward(
            ("127.0.0.1", local.port()),
            ("127.0.0.1", remote_port),
            "user",
            "secret",
            path.clone(),
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(format!("{error:?}").contains("TCP Bind Error"));
        drop(occupied);
        let error = prepare_forward(
            ("127.0.0.1", local.port()),
            ("127.0.0.1", remote_port),
            "user",
            "secret",
            path,
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(!format!("{error:?}").contains("TCP Bind Error"));
        let retry = TcpListener::bind(local).await.unwrap();
        drop(retry);
    }

    #[test]
    fn short_connections_keep_traffic_until_sampled() {
        let traffic = Traffic::default();
        let connection_send = traffic.send.clone();
        connection_send.fetch_add(120, Ordering::Relaxed);
        drop(connection_send);
        traffic.recv.fetch_add(40, Ordering::Relaxed);
        let sample = traffic.sample();
        assert_eq!((sample.send_bytes, sample.recv_bytes), (120, 40));
        let next = traffic.sample();
        assert_eq!((next.send_bytes, next.recv_bytes), (0, 0));
    }
}
