# SSH GUI

Desktop SSH application built with Tauri 2, React, TypeScript, and Vite+.

## Development

Requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`, pnpm 12.8.1, Rust 1.90+, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

```sh
pnpm test         # Frontend IPC and state regression tests
pnpm build        # Type-check and build the frontend with Vite+
pnpm tauri build  # Build the desktop application and installers
```

Use `pnpm dev` for the frontend development server and `pnpm preview` to preview its production build. SSH commands require the Tauri desktop application.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Architecture

- `src/ui/Forward.tsx`: forwarding form, input validation, and page composition.
- `src/hooks/useForward.ts`: connection state, Tauri commands, event subscriptions, and transfer history.
- `src/ui/TransferChart.tsx`: Chart.js registration and traffic chart rendering.
- `src/component/`: shared input, button, and toast components.
- `src-tauri/src/lib.rs`: application startup, managed state registration, and command registration.
- `src-tauri/src/commands.rs`: Tauri command handlers, shared SSH state, and forwarding task orchestration.
- `src-tauri/src/ssh.rs`: SSH authentication, channels, and socket transport.

The IPC command names and event payloads are the boundary between the frontend hook and Rust command handlers.

## SSH host trust and lifecycle

The first connection shows a SHA-256 host fingerprint. Verify it with the server administrator before choosing **Trust and connect**. Cancel sends no password. Approval applies to that exact public key; a different key on retry requires confirmation again.

Trusted keys are stored in the application's data directory (on Windows, `%APPDATA%/com.ssh-gui.app/known_hosts`), separate from the system SSH configuration. A changed key is rejected even when supplied as a trusted key. For a legitimate key rotation, verify the replacement outside this application, stop forwarding, then remove the corresponding old entry from this file and reconnect.

Startup binds the local port and completes authentication before launching forwarding. One runtime lock serializes startup and shutdown; shutdown cancels and joins all forwarding tasks before another connection can start. SSH connection attempts time out after 30 seconds; disconnect requests time out after 5 seconds. Keepalives detect a lost SSH connection, which resets the frontend state. Individual TCP channel errors show an error without marking the SSH connection as disconnected.

Flow counters are shared across TCP channels and sampled once per second, so closing a short connection does not discard its unsampled traffic.

Run backend checks with `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib`. Tests include a loopback SSH server to check that host approval happens before password authentication, trusted hosts reconnect, and invalid command results return errors. Frontend tests mock IPC and hook state; they do not replace a desktop WebView test.

The SSH backend uses russh 0.64.1 with the ring crypto backend, compression, and RSA support. This avoids the AWS-LC backend's NASM build prerequisite on Windows. Host certificates are pinned by their underlying public key using the same confirmation flow; certificate authorities are not implicitly trusted.
