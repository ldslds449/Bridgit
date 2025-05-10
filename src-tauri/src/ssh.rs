use log::debug;
use tokio::sync::RwLock;
use std::borrow::Cow;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use russh::keys::{load_openssh_certificate, load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{client, ChannelMsg, Disconnect, Preferred};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::ToSocketAddrs;
use tokio_util::sync::CancellationToken;

struct Client {}

// More SSH event handlers
// can be defined in this trait
// In this example, we're only using Channel, so these aren't needed.
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct Session {
    session: client::Handle<Client>,
}

impl Session {
    pub async fn connect<A: ToSocketAddrs>(
        user: impl Into<String>,
        password: impl Into<String>,
        addrs: A,
    ) -> Result<Self> {
        let config = client::Config {
            inactivity_timeout: None,
            preferred: Preferred {
                kex: Cow::Owned(vec![
                    russh::kex::CURVE25519_PRE_RFC_8731,
                    russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
                ]),
                ..Default::default()
            },
            ..<_>::default()
        };

        let config = Arc::new(config);
        let sh = Client {};

        let mut session = client::connect(config, addrs, sh).await?;
        // use publickey authentication, with or without certificate

        let auth_res = session.authenticate_password(user, password).await?;

        if !auth_res.success() {
            anyhow::bail!("Authentication (with publickey) failed");
        }

        Ok(Self { session })
    }

    pub async fn call(&self, command: &str) -> Result<String> {
        let mut channel = self.session.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut code = None;
        let mut stdout = tokio::io::stdout();
        let mut output_vec = Vec::new();

        loop {
            // There's an event available on the session channel
            let Some(msg) = channel.wait().await else {
                break;
            };
            match msg {
                // Write data to the terminal
                ChannelMsg::Data { ref data } => {
                    stdout.write_all(data).await?;
                    stdout.flush().await?;
                    output_vec.extend(data.to_vec());
                }
                // The command has returned an exit code
                ChannelMsg::ExitStatus { exit_status } => {
                    code = Some(exit_status);
                    // cannot leave the loop immediately, there might still be more data to receive
                }
                _ => {}
            }
        }
        code.expect("program did not exit cleanly");
        Ok(String::from_utf8(output_vec).expect("UTF8 convert error"))
    }

    pub async fn forward(
        &self,
        mut stream: TcpStream,
        originator_addr: SocketAddr,
        forward_addr: SocketAddr,
        cancel_token: CancellationToken,
        send_bytes: Arc<RwLock<u64>>,
        recv_bytes: Arc<RwLock<u64>>,
    ) -> Result<()>
    {
        let mut channel = self
            .session
            .channel_open_direct_tcpip(
                forward_addr.ip().to_string(),
                forward_addr.port().into(),
                originator_addr.ip().to_string(),
                originator_addr.port().into(),
            )
            .await?;
        // There's an event available on the session channel
        let mut stream_closed = false;
        let mut buf = vec![0; 65536];
        loop {
            // Handle one of the possible events:
            tokio::select! {
                // There's socket input available from the client
                r = stream.read(&mut buf), if !stream_closed => {
                    match r {
                        Ok(0) => {
                            stream_closed = true;
                            channel.eof().await?;
                        },
                        // Send it to the server
                        Ok(n) => {
                            *send_bytes.write().await += n as u64;
                            channel.data(&buf[..n]).await?
                        },
                        Err(e) => return Err(e.into()),
                    };
                },
                // There's an event available on the session channel
                Some(msg) = channel.wait() => {
                    match msg {
                        // Write data to the client
                        ChannelMsg::Data { ref data } => {
                            *recv_bytes.write().await += data.len() as u64;
                            stream.write_all(data).await?;
                        }
                        ChannelMsg::Eof => {
                            if !stream_closed {
                                channel.eof().await?;
                            }
                            break;
                        }
                        ChannelMsg::WindowAdjusted { new_size:_ }=> {
                            // Ignore this message type
                        }
                        _ => {todo!()}
                    }
                },
                _ = cancel_token.cancelled() => {
                    break;
                }
            }
        }
        Ok(())
    }

    pub async fn close(&mut self) -> Result<()> {
        self.session
            .disconnect(Disconnect::ByApplication, "", "English")
            .await?;
        Ok(())
    }
}
