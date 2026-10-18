# SSH GUI

Desktop SSH application built with Tauri 2, React 19, HeroUI 3, Tailwind CSS 4, TypeScript, and Vite+.

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
- `src/ui/App.tsx` and `src/ui/Manager.css`: responsive workspace shell, light/dark themes, and HeroUI styling.
- `src/component/useConfirmation.tsx`: shared confirmation dialogs, including typed confirmation before clearing all trust records.
- `src-tauri/src/lib.rs`: application startup, managed state registration, and command registration.
- `src-tauri/src/commands.rs`: Tauri command handlers, shared SSH state, and forwarding task orchestration.
- `src-tauri/src/ssh.rs`: SSH authentication, channels, and socket transport.

The IPC command names and event payloads are the boundary between the frontend hook and Rust command handlers.

## SSH host trust and lifecycle

The first connection shows a SHA-256 host fingerprint. Verify it with the server administrator before choosing **Trust and connect**. Cancel sends no password. Approval applies to that exact public key; a different key on retry requires confirmation again.

Trusted keys are read from and saved to `~/.ssh/known_hosts` (on Windows, `%USERPROFILE%/.ssh/known_hosts`), shared with the current user?s OpenSSH client. A changed key is rejected even when supplied as a trusted key. For a legitimate key rotation, verify the replacement outside this application, stop forwarding, then reset the corresponding entry in the Known Hosts page and reconnect.

Startup binds the local port and completes authentication before launching forwarding. One runtime lock serializes startup and shutdown; shutdown cancels and joins all forwarding tasks before another connection can start. SSH connection attempts time out after 30 seconds; disconnect requests time out after 5 seconds. Keepalives detect a lost SSH connection, which resets the frontend state. Individual TCP channel errors show an error without marking the SSH connection as disconnected.

Flow counters are shared across TCP channels and sampled once per second, so closing a short connection does not discard its unsampled traffic.

Run backend checks with `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib`. Tests include a loopback SSH server to check that host approval happens before password authentication, trusted hosts reconnect, and invalid command results return errors. Frontend tests mock IPC and hook state; they do not replace a desktop WebView test.

The SSH backend uses russh 0.64.1 with the ring crypto backend, compression, and RSA support. This avoids the AWS-LC backend's NASM build prerequisite on Windows. Host certificates are pinned by their underlying public key using the same confirmation flow; certificate authorities are not implicitly trusted.

## 功能

- **連接埠轉發**：手動設定或選擇 SSH Config 的 Host 別名。分開設定本機監聽、SSH 伺服器、遠端轉發目的地；目的地主機名稱由 SSH 伺服器解析。支援密碼、指定私鑰與加密私鑰密語。
- **SSH Config**：瀏覽／搜尋、新增 Host、修改簡單 Host 表單、編輯／刪除個別區塊、完整原文編輯與儲存前比較。Include 來源檔案的 Host 會顯示來源位置，第一版僅在來源檔案編輯。
- **Known Hosts**：列出主機、金鑰類型、標記與 SHA256 指紋；可查詢雜湊記錄、刪除完整記錄行、重置指定主機與 Port、清空及還原。重置不會自動信任新金鑰。同一行列出的其他主機別名也會一起移除，操作前會顯示確認。

## 檔案與備份

Config 使用目前帳號的 `~/.ssh/config`（Windows 使用 `%USERPROFILE%`）。Known Hosts 預設管理本程式資料目錄的信任檔案，也可切換至使用者的 `~/.ssh/known_hosts`；兩者不會自動合併。不讀寫系統層級的 SSH 設定。

既有檔案修改前會備份至同目錄的 `config.ssh-gui.bak` 或 `known_hosts.ssh-gui.bak`，各保留**上一版**；還原時會先備份目前內容，因此可再還原一次切換回去。首次建立不存在的檔案沒有上一版備份。

寫入前會檢查外部修改並以暫存檔替換，保留檔案權限；Windows 替換既有檔案時保留 ACL。符號連結不接受寫入，以免覆蓋連結。外部程式仍可能在最後檢查與替換之間寫入，請避免同時儲存。

原文編輯不會重新排序或重建設定；表單只修改簡單區塊，進階設定、重複指令及萬用字元區塊請使用原文。

## Config 連線支援範圍

可套用 `Host`、`HostName`、`User`、`Port`、`IdentityFile` 與 `Include`。支援 Host 的 `*`、`?`、否定條件、基本欄位先取得的值優先、複數 IdentityFile、Include 萬用字元與來源順序。Include 深度限制為 16 層，使用者相對 Include 路徑以 `~/.ssh` 為基準。

IdentityFile 支援 `~/` 與 `%d`、`%h`、`%r`、`%p`、`%n`、`%%`；HostName 支援 `%h`。未指定 IdentityFile 時使用密碼，不自動搜尋預設私鑰或 SSH agent。

`Match`、`ProxyJump`、`ProxyCommand`、`LocalForward`、`UserKnownHostsFile` 及其他未支援設定可原文管理，但轉發解析會明確報錯；不會執行設定內的外部指令。`Match` 出現在檔案中即停止解析。需要這些設定時請使用 OpenSSH，或明確選擇手動連線設定。

Known Hosts 查詢與 Reset 需要 PATH 中有 `ssh-keygen`（OpenSSH Client）。管理頁保留 master 的主機金鑰驗證策略，預設對應程式實際使用的信任檔案；不會自動追蹤 Config 中自訂的 Known Hosts 路徑。

## 驗證

```sh
pnpm build
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

前端測試已整合至 Vite+ 測試套件。Rust 測試只操作暫存目錄，包含設定解析、衝突與備份、雜湊 Known Hosts，以及本機 SSH 登入和轉發測試；雜湊 Known Hosts 測試需要 `ssh-keygen`。不會修改真實的 `.ssh` 檔案或連線到外部主機。
