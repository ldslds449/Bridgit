use anyhow::{Context, Result};
use russh::keys::{self, ssh_key, PublicKeyOrCertificate};
use russh::{client, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct HostKeyRequired {
    pub host: String,
    pub port: u16,
    pub key: String,
    pub fingerprint: String,
    pub is_jump: bool,
}

impl std::fmt::Display for HostKeyRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Confirm SSH host key for {}:{} ({})",
            self.host, self.port, self.fingerprint
        )
    }
}
impl std::error::Error for HostKeyRequired {}

#[derive(Debug, Serialize)]
pub(crate) struct ConnectError {
    message: String,
    host_key: Option<HostKeyRequired>,
}

impl ConnectError {
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            host_key: None,
        }
    }
}

impl From<anyhow::Error> for ConnectError {
    fn from(error: anyhow::Error) -> Self {
        Self {
            message: format!("{error:#}"),
            host_key: error.downcast_ref::<HostKeyRequired>().cloned(),
        }
    }
}

struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    trusted_key: Option<String>,
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        // Pin the underlying host key; a certificate does not grant CA trust.
        let key = key.public_key();
        verify_host_key(
            &self.known_hosts,
            &self.host,
            self.port,
            &key,
            self.trusted_key.as_deref(),
        )?;
        Ok(true)
    }
}

fn verify_host_key(
    path: &Path,
    host: &str,
    port: u16,
    key: &ssh_key::PublicKey,
    approved: Option<&str>,
) -> Result<()> {
    // The library treats every open error as a missing file; fail closed on permission errors.
    match std::fs::File::open(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("Cannot read known_hosts"),
    }
    let known = keys::known_hosts::known_host_keys_path(host, port, path)?;
    if known
        .iter()
        .any(|(_, recorded)| recorded.key_data() == key.key_data())
    {
        return Ok(());
    }
    anyhow::ensure!(known.is_empty(), "SSH host key changed for {host}:{port}; connection refused. Verify the server before updating {}", path.display());
    let public_key = key.to_openssh()?;
    if approved != Some(public_key.as_str()) {
        return Err(HostKeyRequired {
            is_jump: false,
            host: host.into(),
            port,
            key: public_key,
            fingerprint: key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
        }
        .into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    // Leading newline also handles an existing file without a trailing newline.
    let address = if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    };
    writeln!(file, "\n{address} {public_key}")?;
    file.flush()?;
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JumpHost {
    host: String,
    port: u16,
    user: String,
    password: String,
    trusted_key: Option<String>,
}

pub struct Session {
    session: client::Handle<Client>,
    jump: Option<client::Handle<Client>>,
}

impl Session {
    pub async fn connect(
        user: &str,
        password: &str,
        (host, port): (&str, u16),
        known_hosts: PathBuf,
        trusted_key: Option<String>,
        identity_files: &[String],
        passphrase: &str,
    ) -> Result<Self, ConnectError> {
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            let config = Arc::new(client::Config {
                keepalive_interval: Some(Duration::from_secs(10)),
                keepalive_max: 3,
                ..Default::default()
            });
            let handler = Client {
                host: host.into(),
                port,
                known_hosts,
                trusted_key,
            };
            let mut session = client::connect(config, (host, port), handler).await?;
            Self::authenticate(&mut session, user, password, identity_files, passphrase).await?;
            Ok::<_, anyhow::Error>(Self {
                session,
                jump: None,
            })
        })
        .await;
        match result {
            Ok(result) => result.map_err(ConnectError::from),
            Err(_) => Err(ConnectError::message("SSH connection timed out")),
        }
    }

    async fn authenticate(
        session: &mut client::Handle<Client>,
        user: &str,
        password: &str,
        identity_files: &[String],
        passphrase: &str,
    ) -> Result<()> {
        let mut authenticated = false;
        let mut key_error = None;
        for path in identity_files {
            let key = match keys::load_secret_key(
                path,
                if passphrase.is_empty() {
                    None
                } else {
                    Some(passphrase)
                },
            ) {
                Ok(key) => key,
                Err(error) => {
                    key_error = Some(format!("{path}: {error}"));
                    continue;
                }
            };
            let hash = session.best_supported_rsa_hash().await?.flatten();
            if session
                .authenticate_publickey(user, keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
                .success()
            {
                authenticated = true;
                break;
            }
        }
        if !authenticated && !password.is_empty() {
            authenticated = session
                .authenticate_password(user, password)
                .await?
                .success();
        }
        anyhow::ensure!(
            authenticated,
            "Authentication failed{}",
            key_error.map(|e| format!(": {e}")).unwrap_or_default()
        );
        Ok(())
    }

    pub(crate) async fn connect_via(
        user: &str,
        password: &str,
        (host, port): (&str, u16),
        known_hosts: PathBuf,
        trusted_key: Option<String>,
        identity_files: &[String],
        passphrase: &str,
        jump: Option<JumpHost>,
    ) -> Result<Self, ConnectError> {
        let Some(jump) = jump else {
            return Self::connect(
                user,
                password,
                (host, port),
                known_hosts,
                trusted_key,
                identity_files,
                passphrase,
            )
            .await;
        };
        if jump.host.trim().is_empty()
            || jump.port == 0
            || jump.user.is_empty()
            || jump.password.is_empty()
        {
            return Err(ConnectError::message(
                "Jump host, port, user and password are required",
            ));
        }
        let outer = Self::connect(
            &jump.user,
            &jump.password,
            (&jump.host, jump.port),
            known_hosts.clone(),
            jump.trusted_key,
            &[],
            "",
        )
        .await
        .map_err(|mut error| {
            if let Some(key) = error.host_key.as_mut() {
                key.is_jump = true;
            }
            error.message = format!("Jump host: {}", error.message);
            error
        })?;
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            let channel = outer
                .session
                .channel_open_direct_tcpip(host, port.into(), "127.0.0.1", 0)
                .await?;
            let config = Arc::new(client::Config {
                keepalive_interval: Some(Duration::from_secs(10)),
                keepalive_max: 3,
                ..Default::default()
            });
            let handler = Client {
                host: host.into(),
                port,
                known_hosts,
                trusted_key,
            };
            let mut session =
                client::connect_stream(config, channel.into_stream(), handler).await?;
            Self::authenticate(&mut session, user, password, identity_files, passphrase).await?;
            Ok::<_, anyhow::Error>(session)
        })
        .await;
        match result {
            Ok(Ok(session)) => Ok(Self {
                session,
                jump: Some(outer.session),
            }),
            error => {
                let _ = outer.close().await;
                Err(match error {
                    Ok(Err(error)) => ConnectError::from(error),
                    _ => ConnectError::message("Target SSH connection timed out"),
                })
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.session.is_closed() || self.jump.as_ref().is_some_and(|jump| jump.is_closed())
    }

    pub async fn call(&self, command: &str) -> Result<String> {
        let mut channel = self.session.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut code = None;
        let mut output_vec = Vec::new();

        loop {
            // There's an event available on the session channel
            let Some(msg) = channel.wait().await else {
                break;
            };
            match msg {
                // Collect stdout without assuming it is UTF-8 yet
                ChannelMsg::Data { ref data } => {
                    output_vec.extend_from_slice(data);
                }
                // The command has returned an exit code
                ChannelMsg::ExitStatus { exit_status } => {
                    code = Some(exit_status);
                    // cannot leave the loop immediately, there might still be more data to receive
                }
                _ => {}
            }
        }
        command_output(code, output_vec)
    }

    pub async fn forward(
        &self,
        mut stream: TcpStream,
        originator_addr: SocketAddr,
        forward_addr: (String, u16),
        send_bytes: Arc<AtomicU64>,
        recv_bytes: Arc<AtomicU64>,
    ) -> Result<()> {
        let channel = self
            .session
            .channel_open_direct_tcpip(
                forward_addr.0,
                forward_addr.1.into(),
                originator_addr.ip().to_string(),
                originator_addr.port().into(),
            )
            .await?;
        // shortcut: russh can stall session I/O when its receive queue fills; revisit on upgrade.
        let (mut channel_reader, channel_writer) = channel.split();
        let mut writer = channel_writer.make_writer();
        let (mut socket_reader, mut socket_writer) = stream.split();
        let result: Result<()> = async {
            let upload = async {
                let mut buf = vec![0; 65536];
                loop {
                    let n = socket_reader.read(&mut buf).await?;
                    if n == 0 {
                        writer.shutdown().await?;
                        return Ok::<_, anyhow::Error>(());
                    }
                    writer.write_all(&buf[..n]).await?;
                    send_bytes.fetch_add(n as u64, Ordering::Relaxed);
                }
            };
            tokio::pin!(upload);
            let (remote_end, upload_done) = {
                let download = async {
                    loop {
                        let message = channel_reader.wait().await;
                        match &message {
                            Some(ChannelMsg::Data { data }) => {
                                socket_writer.write_all(data).await?;
                                recv_bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                recv_bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
                            }
                            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                                socket_writer.shutdown().await?;
                                return Ok::<_, anyhow::Error>(message);
                            }
                            _ => {}
                        }
                    }
                };
                tokio::pin!(download);
                tokio::select! {
                    result = &mut upload => { result?; (download.await?, true) }
                    result = &mut download => (result?, false),
                }
            };
            // EOF closes one direction; a subsequent channel close must also stop upload.
            if !upload_done && matches!(remote_end, Some(ChannelMsg::Eof)) {
                tokio::select! {
                    result = upload => result?,
                    _ = async {
                        while let Some(message) = channel_reader.wait().await {
                            if matches!(message, ChannelMsg::Close) { break; }
                        }
                    } => {}
                }
            }
            Ok(())
        }
        .await;
        let close_result = channel_writer.close().await;
        result?;
        close_result?;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        let target = if self.session.is_closed() {
            Ok(())
        } else {
            tokio::time::timeout(
                Duration::from_secs(5),
                self.session.disconnect(Disconnect::ByApplication, "", ""),
            )
            .await
            .context("SSH disconnect timed out")
            .and_then(|result| result.map_err(anyhow::Error::from))
        };
        let jump = if let Some(jump) = self.jump.as_ref().filter(|jump| !jump.is_closed()) {
            tokio::time::timeout(
                Duration::from_secs(5),
                jump.disconnect(Disconnect::ByApplication, "", ""),
            )
            .await
            .context("Jump host disconnect timed out")
            .and_then(|result| result.map_err(anyhow::Error::from))
        } else {
            Ok(())
        };
        target.and(jump)?;
        Ok(())
    }
}

fn command_output(code: Option<u32>, output: Vec<u8>) -> Result<String> {
    let code = code.context("Remote command ended without an exit status")?;
    anyhow::ensure!(code == 0, "Remote command exited with status {code}");
    String::from_utf8(output).context("Remote command returned invalid UTF-8")
}
#[cfg(test)]
mod tests {
    use super::*;
    use russh::server;
    use tokio::net::TcpListener;

    fn test_key(seed: u8) -> ssh_key::PrivateKey {
        let pair = ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]);
        ssh_key::PrivateKey::new(pair.into(), "").unwrap()
    }

    struct TestFile(PathBuf);
    impl TestFile {
        fn new() -> Self {
            let id = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(
                std::env::temp_dir()
                    .join(format!("ssh-gui-test-{}-{id}", std::process::id()))
                    .join("known_hosts"),
            )
        }
    }
    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_dir(self.0.parent().unwrap());
        }
    }

    #[test]
    fn host_trust_requires_the_exact_key_and_rejects_changes() {
        for port in [22, 2222] {
            let file = TestFile::new();
            let first = test_key(1);
            let changed = test_key(2);
            let key = first.public_key();
            let error = verify_host_key(&file.0, "127.0.0.1", port, key, None).unwrap_err();
            assert!(error.downcast_ref::<HostKeyRequired>().is_some());
            assert!(!file.0.exists());
            let wrong = changed.public_key().to_openssh().unwrap();
            assert!(verify_host_key(&file.0, "127.0.0.1", port, key, Some(&wrong)).is_err());
            assert!(!file.0.exists());
            let approved = key.to_openssh().unwrap();
            verify_host_key(&file.0, "127.0.0.1", port, key, Some(&approved)).unwrap();
            verify_host_key(&file.0, "127.0.0.1", port, key, None).unwrap();
            let mut annotated = key.clone();
            annotated.set_comment("a local comment is not part of host identity");
            verify_host_key(&file.0, "127.0.0.1", port, &annotated, None).unwrap();
            let error = verify_host_key(
                &file.0,
                "127.0.0.1",
                port,
                changed.public_key(),
                Some(&wrong),
            )
            .unwrap_err();
            assert!(error.to_string().contains("host key changed"));
            assert!(error.downcast_ref::<HostKeyRequired>().is_none());
        }
    }

    #[tokio::test]
    async fn host_certificate_still_requires_an_explicit_key_pin() {
        let file = TestFile::new();
        let ca = test_key(8);
        let host = test_key(9);
        let mut builder = ssh_key::certificate::Builder::new(
            vec![42; 16],
            host.public_key().key_data().clone(),
            0,
            u64::MAX,
        )
        .unwrap();
        builder
            .cert_type(ssh_key::certificate::CertType::Host)
            .unwrap();
        builder.valid_principal("127.0.0.1").unwrap();
        let certificate = PublicKeyOrCertificate::from(builder.sign(&ca).unwrap());
        let mut client = Client {
            host: "127.0.0.1".into(),
            port: 22,
            known_hosts: file.0.clone(),
            trusted_key: None,
        };
        let error = client::Handler::check_server_key(&mut client, &certificate)
            .await
            .unwrap_err();
        let challenge = error.downcast_ref::<HostKeyRequired>().unwrap();
        assert_eq!(challenge.key, host.public_key().to_openssh().unwrap());
        assert!(!file.0.exists());
        client.trusted_key = Some(challenge.key.clone());
        assert!(client::Handler::check_server_key(&mut client, &certificate)
            .await
            .unwrap());
        client.trusted_key = None;
        assert!(client::Handler::check_server_key(&mut client, &certificate)
            .await
            .unwrap());
        let changed = PublicKeyOrCertificate::from(test_key(10).public_key().clone());
        assert!(client::Handler::check_server_key(&mut client, &changed)
            .await
            .unwrap_err()
            .to_string()
            .contains("host key changed"));
    }

    #[test]
    fn remote_command_errors_are_results() {
        assert_eq!(command_output(Some(0), b"ok".to_vec()).unwrap(), "ok");
        assert!(command_output(None, vec![])
            .unwrap_err()
            .to_string()
            .contains("exit status"));
        assert!(command_output(Some(2), vec![])
            .unwrap_err()
            .to_string()
            .contains("status 2"));
        assert!(command_output(Some(0), vec![0xff])
            .unwrap_err()
            .to_string()
            .contains("UTF-8"));
    }

    struct TestServer(
        Arc<AtomicU64>,
        Option<tokio::sync::mpsc::UnboundedSender<Result<usize, String>>>,
    );

    #[tokio::test]
    async fn encrypted_identity_authentication_and_hostname_forwarding() {
        tokio::time::timeout(Duration::from_secs(30), async {
            struct IdentityServer(ssh_key::PublicKey);
            impl server::Handler for IdentityServer {
                type Error = anyhow::Error;
                async fn auth_publickey(
                    &mut self,
                    user: &str,
                    key: &ssh_key::PublicKey,
                ) -> Result<server::Auth> {
                    Ok(if user == "tester" && key.key_data() == self.0.key_data() {
                        server::Auth::Accept
                    } else {
                        server::Auth::reject()
                    })
                }
                async fn channel_open_direct_tcpip(
                    &mut self,
                    channel: russh::Channel<server::Msg>,
                    host: &str,
                    port: u32,
                    _: &str,
                    _: u32,
                    reply: server::ChannelOpenHandle,
                    _: &mut server::Session,
                ) -> Result<()> {
                    assert_eq!((host, port), ("database.internal", 5432));
                    reply.accept().await;
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        stream.write_all(b"forwarded").await.unwrap();
                        stream.shutdown().await.unwrap();
                    });
                    Ok(())
                }
            }
            let file = TestFile::new();
            std::fs::create_dir_all(file.0.parent().unwrap()).unwrap();
            let identity = file.0.with_file_name("id_ed25519");
            let mut keygen = std::process::Command::new("ssh-keygen");
            keygen
                .args(["-q", "-t", "ed25519", "-N", "test-passphrase", "-f"])
                .arg(&identity);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                keygen.creation_flags(0x08000000);
            }
            assert!(keygen.output().unwrap().status.success());
            let mut key = keys::load_secret_key(&identity, Some("test-passphrase")).unwrap();
            key.set_comment("");
            let public = key.public_key().to_openssh().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let config = Arc::new(server::Config {
                keys: vec![key.clone()],
                ..Default::default()
            });
            let server = tokio::spawn(async move {
                let mut sessions = tokio::task::JoinSet::new();
                loop {
                    let (socket, _) = listener.accept().await.unwrap();
                    let config = config.clone();
                    let public = key.public_key().clone();
                    sessions.spawn(async move {
                        if let Ok(session) =
                            server::run_stream(config, socket, IdentityServer(public)).await
                        {
                            let _ = session.await;
                        }
                    });
                }
            });
            let identities = vec![identity.display().to_string()];
            assert!(Session::connect(
                "tester",
                "",
                ("127.0.0.1", address.port()),
                file.0.clone(),
                Some(public.clone()),
                &identities,
                "wrong-passphrase"
            )
            .await
            .is_err());
            let session = Session::connect(
                "tester",
                "",
                ("127.0.0.1", address.port()),
                file.0.clone(),
                Some(public),
                &identities,
                "test-passphrase",
            )
            .await
            .unwrap();
            let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut client = TcpStream::connect(local.local_addr().unwrap())
                .await
                .unwrap();
            let (socket, origin) = local.accept().await.unwrap();
            let send = Arc::new(AtomicU64::new(0));
            let recv = Arc::new(AtomicU64::new(0));
            let (forwarded, received) = tokio::join!(
                session.forward(
                    socket,
                    origin,
                    ("database.internal".into(), 5432),
                    send,
                    recv.clone()
                ),
                async {
                    let mut data = Vec::new();
                    client.read_to_end(&mut data).await.unwrap();
                    client.shutdown().await.unwrap();
                    data
                }
            );
            forwarded.unwrap();
            assert_eq!(received, b"forwarded");
            assert_eq!(recv.load(Ordering::Relaxed), 9);
            session.close().await.unwrap();
            server.abort();
            let _ = server.await;
            std::fs::remove_file(&identity).unwrap();
            std::fs::remove_file(identity.with_extension("pub")).unwrap();
        })
        .await
        .expect("local SSH identity test timed out");
    }

    struct JumpServer(Arc<AtomicU64>);

    impl server::Handler for JumpServer {
        type Error = anyhow::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth> {
            anyhow::ensure!(
                user == "jump-user" && password == "jump-password",
                "Wrong jump credentials"
            );
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(server::Auth::Accept)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<server::Msg>,
            host: &str,
            port: u32,
            _origin: &str,
            _origin_port: u32,
            reply: server::ChannelOpenHandle,
            _session: &mut server::Session,
        ) -> Result<()> {
            let mut socket = TcpStream::connect((host, u16::try_from(port)?)).await?;
            reply.accept().await;
            tokio::spawn(async move {
                let _ =
                    tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut socket).await;
            });
            Ok(())
        }
    }

    #[tokio::test]
    async fn jump_requires_both_host_approvals_before_each_password() {
        let file = TestFile::new();
        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = target_listener.local_addr().unwrap().port();
        let jump_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let jump_port = jump_listener.local_addr().unwrap().port();
        let target_key = test_key(7);
        let target_public = target_key.public_key().to_openssh().unwrap();
        let jump_key = test_key(8);
        let jump_public = jump_key.public_key().to_openssh().unwrap();
        let target_auth = Arc::new(AtomicU64::new(0));
        let jump_auth = Arc::new(AtomicU64::new(0));
        let target_count = target_auth.clone();
        let jump_count = jump_auth.clone();
        let target_server = tokio::spawn(async move {
            let config = Arc::new(server::Config {
                keys: vec![target_key],
                ..Default::default()
            });
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                let (socket, _) = target_listener.accept().await.unwrap();
                let config = config.clone();
                let count = target_count.clone();
                sessions.spawn(async move {
                    if let Ok(session) =
                        server::run_stream(config, socket, TestServer(count, None)).await
                    {
                        let _ = session.await;
                    }
                });
            }
        });
        let jump_server = tokio::spawn(async move {
            let config = Arc::new(server::Config {
                keys: vec![jump_key],
                ..Default::default()
            });
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                let (socket, _) = jump_listener.accept().await.unwrap();
                let config = config.clone();
                let count = jump_count.clone();
                sessions.spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, JumpServer(count)).await
                    {
                        let _ = session.await;
                    }
                });
            }
        });
        let mut jump = JumpHost {
            host: "127.0.0.1".into(),
            port: jump_port,
            user: "jump-user".into(),
            password: "jump-password".into(),
            trusted_key: None,
        };
        let first = Session::connect_via(
            "target-user",
            "target-password",
            ("127.0.0.1", target_port),
            file.0.clone(),
            None,
            &[],
            "",
            Some(jump.clone()),
        )
        .await
        .err()
        .unwrap();
        assert!(first.host_key.as_ref().unwrap().is_jump);
        assert_eq!(first.host_key.unwrap().key, jump_public);
        assert_eq!(jump_auth.load(Ordering::Relaxed), 0);
        assert_eq!(target_auth.load(Ordering::Relaxed), 0);
        jump.trusted_key = Some(jump_public);
        let second = Session::connect_via(
            "target-user",
            "target-password",
            ("127.0.0.1", target_port),
            file.0.clone(),
            None,
            &[],
            "",
            Some(jump.clone()),
        )
        .await
        .err()
        .unwrap();
        assert!(!second.host_key.as_ref().unwrap().is_jump);
        assert_eq!(second.host_key.unwrap().key, target_public);
        assert_eq!(jump_auth.load(Ordering::Relaxed), 1);
        assert_eq!(target_auth.load(Ordering::Relaxed), 0);
        let session = Session::connect_via(
            "target-user",
            "target-password",
            ("127.0.0.1", target_port),
            file.0.clone(),
            Some(target_public),
            &[],
            "",
            Some(jump),
        )
        .await
        .unwrap();
        assert_eq!(jump_auth.load(Ordering::Relaxed), 2);
        assert_eq!(target_auth.load(Ordering::Relaxed), 1);
        assert!(!session.is_closed());
        let channel = session
            .session
            .channel_open_direct_tcpip("127.0.0.1", 1234, "127.0.0.1", 0)
            .await
            .unwrap();
        let mut stream = channel.into_stream();
        stream.write_all(b"through jump").await.unwrap();
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut output))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(output, b"through jump");
        session.close().await.unwrap();
        target_server.abort();
        jump_server.abort();
    }
    impl server::Handler for TestServer {
        type Error = anyhow::Error;
        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<server::Auth> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(server::Auth::Accept)
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<server::Msg>,
            _host: &str,
            port: u32,
            _origin: &str,
            _origin_port: u32,
            reply: server::ChannelOpenHandle,
            _session: &mut server::Session,
        ) -> Result<()> {
            reply.accept().await;
            if let Some(report) = self.1.clone() {
                tokio::spawn(async move {
                    let mut stream = channel.into_stream();
                    let result: Result<usize> = async {
                        match port {
                            1 => {
                                stream.write_all(b"ready").await?;
                                stream.shutdown().await?;
                                let mut input = Vec::new();
                                stream.read_to_end(&mut input).await?;
                                anyhow::ensure!(
                                    input == b"after EOF",
                                    "upload after remote EOF was lost"
                                );
                                Ok(input.len())
                            }
                            2 => {
                                let mut input = Vec::new();
                                stream.read_to_end(&mut input).await?;
                                stream.write_all(&input).await?;
                                stream.shutdown().await?;
                                Ok(input.len())
                            }
                            3 => {
                                let (mut reader, mut writer) = tokio::io::split(stream);
                                let receive = async {
                                    let mut input = Vec::new();
                                    reader.read_to_end(&mut input).await?;
                                    anyhow::ensure!(
                                        input == vec![7; BULK_SIZE],
                                        "bulk upload corrupted"
                                    );
                                    Ok::<_, anyhow::Error>(input.len())
                                };
                                let send = async {
                                    writer.write_all(&vec![9; DOWNLOAD_SIZE]).await?;
                                    writer.shutdown().await?;
                                    Ok::<_, anyhow::Error>(())
                                };
                                let (count, ()) = tokio::try_join!(receive, send)?;
                                Ok(count)
                            }
                            4 => {
                                let mut input = Vec::new();
                                stream.read_to_end(&mut input).await?;
                                Ok(input.len())
                            }
                            _ => unreachable!(),
                        }
                    }
                    .await;
                    let _ = report.send(result.map_err(|error| error.to_string()));
                });
            }
            Ok(())
        }

        async fn data(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<()> {
            if self.1.is_some() {
                return Ok(());
            }
            session.data(channel, data.to_vec())?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn real_handshake_confirms_host_before_sending_password() {
        let file = TestFile::new();
        let key = test_key(3);
        let public = key.public_key().to_openssh().unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let authentications = Arc::new(AtomicU64::new(0));
        let count = authentications.clone();
        let server = tokio::spawn(async move {
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let config = config.clone();
                let count = count.clone();
                sessions.spawn(async move {
                    if let Ok(session) =
                        server::run_stream(config, socket, TestServer(count, None)).await
                    {
                        let _ = session.await;
                    }
                });
            }
        });
        let first = Session::connect(
            "user",
            "secret",
            ("127.0.0.1", address.port()),
            file.0.clone(),
            None,
            &[],
            "",
        )
        .await;
        let error = first.err().expect("unknown host must be rejected");
        assert_eq!(error.host_key.as_ref().unwrap().key, public);
        assert_eq!(authentications.load(Ordering::Relaxed), 0);
        let session = Session::connect(
            "user",
            "secret",
            ("127.0.0.1", address.port()),
            file.0.clone(),
            Some(public),
            &[],
            "",
        )
        .await
        .unwrap();
        assert_eq!(authentications.load(Ordering::Relaxed), 1);
        session.close().await.unwrap();
        let session = Session::connect(
            "user",
            "secret",
            ("127.0.0.1", address.port()),
            file.0.clone(),
            None,
            &[],
            "",
        )
        .await
        .unwrap();
        assert_eq!(authentications.load(Ordering::Relaxed), 2);
        let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(local.local_addr().unwrap())
            .await
            .unwrap();
        let (socket, origin) = local.accept().await.unwrap();
        let send = Arc::new(AtomicU64::new(0));
        let recv = Arc::new(AtomicU64::new(0));
        let transferred = tokio::time::timeout(Duration::from_secs(5), async {
            let forwarding = session.forward(
                socket,
                origin,
                (address.ip().to_string(), address.port()),
                send.clone(),
                recv.clone(),
            );
            let client_io = async {
                client.write_all(b"hello").await.unwrap();
                let mut echo = [0; 5];
                client.read_exact(&mut echo).await.unwrap();
                assert_eq!(&echo, b"hello");
            };
            let (forwarded, ()) = tokio::join!(forwarding, client_io);
            forwarded.unwrap();
        })
        .await;
        transferred.expect("forwarding must finish after remote EOF");
        assert_eq!(send.load(Ordering::Relaxed), 5);
        assert_eq!(recv.load(Ordering::Relaxed), 5);
        session.close().await.unwrap();
        server.abort();
        let _ = server.await;
    }

    const BULK_SIZE: usize = 8 * 1024 * 1024;
    const DOWNLOAD_SIZE: usize = 64 * 1024;

    async fn forwarding_case(mode: u16) {
        tokio::time::timeout(Duration::from_secs(20), async {
            let file = TestFile::new();
            let key = test_key(4);
            let public = key.public_key().to_openssh().unwrap();
            let config = Arc::new(server::Config {
                keys: vec![key],
                ..Default::default()
            });
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (report, mut reports) = tokio::sync::mpsc::unbounded_channel();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                if let Ok(session) = server::run_stream(
                    config,
                    socket,
                    TestServer(Arc::new(AtomicU64::new(0)), Some(report)),
                )
                .await
                {
                    let _ = session.await;
                }
            });
            let session = Arc::new(
                Session::connect(
                    "user",
                    "secret",
                    ("127.0.0.1", address.port()),
                    file.0.clone(),
                    Some(public),
                    &[],
                    "",
                )
                .await
                .unwrap(),
            );
            let local_socket = tokio::net::TcpSocket::new_v4().unwrap();
            local_socket.set_send_buffer_size(4096).unwrap();
            local_socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
            let local = local_socket.listen(1).unwrap();
            let client_socket = tokio::net::TcpSocket::new_v4().unwrap();
            client_socket.set_recv_buffer_size(4096).unwrap();
            let mut client = client_socket
                .connect(local.local_addr().unwrap())
                .await
                .unwrap();
            let (socket, origin) = local.accept().await.unwrap();
            let send = Arc::new(AtomicU64::new(0));
            let recv = Arc::new(AtomicU64::new(0));
            let target = (address.ip().to_string(), mode);
            if mode == 4 {
                let worker_session = session.clone();
                let worker_send = send.clone();
                let worker_recv = recv.clone();
                let mut workers = tokio::task::JoinSet::new();
                workers.spawn(async move {
                    worker_session
                        .forward(socket, origin, target, worker_send, worker_recv)
                        .await
                });
                client.write_all(b"cancel").await.unwrap();
                while send.load(Ordering::Relaxed) == 0 {
                    tokio::task::yield_now().await;
                }
                workers.abort_all();
                assert!(workers
                    .join_next()
                    .await
                    .unwrap()
                    .unwrap_err()
                    .is_cancelled());
                assert_eq!(client.read(&mut [0; 1]).await.unwrap(), 0);
            } else {
                let forwarding =
                    session.forward(socket, origin, target, send.clone(), recv.clone());
                let client_io = async {
                    match mode {
                        1 => {
                            let mut greeting = Vec::new();
                            client.read_to_end(&mut greeting).await.unwrap();
                            assert_eq!(greeting, b"ready");
                            client.write_all(b"after EOF").await.unwrap();
                            client.shutdown().await.unwrap();
                        }
                        2 => {
                            client.write_all(b"after local EOF").await.unwrap();
                            client.shutdown().await.unwrap();
                            let mut reply = Vec::new();
                            client.read_to_end(&mut reply).await.unwrap();
                            assert_eq!(reply, b"after local EOF");
                        }
                        3 => {
                            // Delay reading until upload finishes to expose cross-direction blocking.
                            client.write_all(&vec![7; BULK_SIZE]).await.unwrap();
                            client.shutdown().await.unwrap();
                            let mut reply = Vec::new();
                            client.read_to_end(&mut reply).await.unwrap();
                            assert_eq!(reply, vec![9; DOWNLOAD_SIZE]);
                        }
                        _ => unreachable!(),
                    }
                };
                let (forwarded, ()) = tokio::join!(forwarding, client_io);
                forwarded.unwrap();
                let expected = match mode {
                    1 => (9, 5),
                    2 => (15, 15),
                    3 => (BULK_SIZE as u64, DOWNLOAD_SIZE as u64),
                    _ => unreachable!(),
                };
                assert_eq!(
                    (send.load(Ordering::Relaxed), recv.load(Ordering::Relaxed)),
                    expected
                );
                assert_eq!(reports.recv().await.unwrap().unwrap() as u64, expected.0);
            }
            session.close().await.unwrap();
            server.abort();
            let _ = server.await;
        })
        .await
        .expect("forwarding must not stall");
    }

    #[tokio::test]
    async fn remote_eof_still_allows_upload() {
        forwarding_case(1).await;
    }

    #[tokio::test]
    async fn local_eof_still_allows_download() {
        forwarding_case(2).await;
    }

    #[tokio::test]
    async fn blocked_download_does_not_block_upload() {
        forwarding_case(3).await;
    }

    #[tokio::test]
    async fn aborting_forward_releases_the_tcp_connection() {
        forwarding_case(4).await;
    }
}
