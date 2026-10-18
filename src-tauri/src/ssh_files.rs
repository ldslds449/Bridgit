use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

static FILE_LOCK: Mutex<()> = Mutex::new(());

pub fn home() -> Result<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .context("找不到使用者家目錄")
}

pub(crate) fn path(kind: &str) -> Result<PathBuf> {
    if !matches!(kind, "config" | "known_hosts") {
        bail!("不支援的檔案");
    }
    Ok(home()?.join(".ssh").join(kind))
}

fn managed_path(kind: &str, app: &AppHandle) -> Result<PathBuf> {
    if kind == "app_known_hosts" {
        return Ok(app.path().app_data_dir()?.join("known_hosts"));
    }
    path(kind)
}

fn content(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("無法讀取 {}", path.display())),
    }
}

#[derive(Serialize)]
pub struct Document {
    path: String,
    content: Option<String>,
    backup: bool,
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("ssh-gui.bak")
}

fn document(path: &Path) -> Result<Document> {
    Ok(Document {
        path: path.display().to_string(),
        content: content(path)?,
        backup: backup_path(path).exists(),
    })
}

fn private_file(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

#[cfg(windows)]
fn replace(temp: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    if !destination.exists() {
        return Ok(fs::rename(temp, destination)?);
    }
    let dest: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let tmp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        ReplaceFileW(
            dest.as_ptr(),
            tmp.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace(temp: &Path, destination: &Path) -> Result<()> {
    Ok(fs::rename(temp, destination)?)
}

fn atomic_write(path: &Path, text: &str) -> Result<()> {
    let temp = path.with_extension(format!("ssh-gui-{}.tmp", std::process::id()));
    let mut file = private_file(&temp).context("無法建立暫存檔；請檢查權限或殘留暫存檔")?;
    let result = (|| -> Result<()> {
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn save(path: &Path, expected: &Option<String>, text: &str) -> Result<Document> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("此檔案是符號連結；請在連結的來源檔案修改，避免替換連結");
    }
    if &content(path)? != expected {
        bail!("檔案已被其他程式修改，請重新載入後再操作");
    }
    let parent = path.parent().context("無效路徑")?;
    if !parent.exists() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
    }
    if let Some(old) = expected {
        atomic_write(&backup_path(path), old)?;
    }
    // shortcut: external writers do not share our lock; use OS file locking if concurrent writes become common.
    if &content(path)? != expected {
        bail!("檔案已被其他程式修改，請重新載入");
    }
    atomic_write(path, text)?;
    document(path)
}

#[tauri::command]
pub fn read_ssh_file(kind: String, app: AppHandle) -> Result<Document, String> {
    (|| -> Result<_> {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("檔案鎖定失敗"))?;
        document(&managed_path(&kind, &app)?)
    })()
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_ssh_file(
    kind: String,
    expected: Option<String>,
    text: String,
) -> Result<Document, String> {
    (|| -> Result<_> {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("檔案鎖定失敗"))?;
        if kind != "config" {
            bail!("Known Hosts 請使用刪除或重置操作");
        }
        validate(&text)?;
        save(&path(&kind)?, &expected, &text)
    })()
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn restore_ssh_file(
    kind: String,
    expected: Option<String>,
    app: AppHandle,
) -> Result<Document, String> {
    (|| -> Result<_> {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("檔案鎖定失敗"))?;
        let path = managed_path(&kind, &app)?;
        let backup = content(&backup_path(&path))?.context("沒有可還原的備份")?;
        save(&path, &expected, &backup)
    })()
    .map_err(|e| format!("{e:#}"))
}

// Keep backslashes in Windows paths; only quotes and comments delimit tokens.
fn tokens(line: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    for ch in line.trim_start_matches('\u{feff}').chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                token.push(ch);
            }
        } else {
            match ch {
                '#' => break,
                '"' | '\'' => quote = Some(ch),
                '=' if result.is_empty() || (result.len() == 1 && token.is_empty()) => {
                    if !token.is_empty() {
                        result.push(std::mem::take(&mut token));
                    }
                }
                c if c.is_whitespace() => {
                    if !token.is_empty() {
                        result.push(std::mem::take(&mut token));
                    }
                }
                c => token.push(c),
            }
        }
    }
    if quote.is_some() {
        bail!("引號未關閉");
    }
    if !token.is_empty() {
        result.push(token);
    }
    Ok(result)
}

fn validate(text: &str) -> Result<()> {
    if text.contains('\0') {
        bail!("設定不可含 NUL");
    }
    for (i, line) in text.lines().enumerate() {
        let t = tokens(line).with_context(|| format!("第 {} 行", i + 1))?;
        if t.len() == 1 {
            bail!("第 {} 行缺少設定值", i + 1);
        }
        if t.first().is_some_and(|k| k.eq_ignore_ascii_case("port")) {
            if t.len() != 2 || t[1].parse::<u16>().ok().filter(|p| *p > 0).is_none() {
                bail!("第 {} 行 Port 必須介於 1–65535", i + 1);
            }
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct HostEntry {
    pub name: String,
    pub source: String,
    pub line: usize,
}

fn expand_home(value: &str, home: &Path) -> Result<PathBuf> {
    if value == "~" {
        return Ok(home.to_owned());
    }
    if value.starts_with("~/") || value.starts_with("~\\") {
        return Ok(home.join(&value[2..]));
    }
    if value.starts_with('~') || value.contains("${") {
        bail!("尚未支援的路徑展開：{value}");
    }
    Ok(PathBuf::from(value))
}

fn includes(value: &str, home: &Path) -> Result<Vec<PathBuf>> {
    let expanded = expand_home(value, home)?;
    let expanded = if expanded.is_absolute() {
        expanded
    } else {
        home.join(".ssh").join(expanded)
    };
    let mut paths = glob::glob(expanded.to_str().context("無效的 Include 路徑")?)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    paths.sort();
    Ok(paths)
}

fn read_tree(path: &Path, home: &Path, depth: usize, entries: &mut Vec<HostEntry>) -> Result<()> {
    if depth > 16 {
        bail!("Include 遞迴超過 16 層，可能有循環引用");
    }
    let text = content(path)?.unwrap_or_default();
    for (i, line) in text.lines().enumerate() {
        let t = tokens(line).with_context(|| format!("{}:{}", path.display(), i + 1))?;
        if t.is_empty() {
            continue;
        }
        if t[0].eq_ignore_ascii_case("host") {
            for name in &t[1..] {
                if !name.contains(['*', '?', '!']) {
                    entries.push(HostEntry {
                        name: name.clone(),
                        source: path.display().to_string(),
                        line: i + 1,
                    });
                }
            }
        } else if t[0].eq_ignore_ascii_case("include") {
            for value in &t[1..] {
                for p in includes(value, home)? {
                    read_tree(&p, home, depth + 1, entries)?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_hosts() -> Result<Vec<HostEntry>, String> {
    (|| -> Result<_> {
        let mut entries = Vec::new();
        read_tree(&path("config")?, &home()?, 0, &mut entries)?;
        Ok(entries)
    })()
    .map_err(|e| format!("{e:#}"))
}

fn matches_host(patterns: &[String], host: &str) -> Result<bool> {
    let mut matched = false;
    for pattern in patterns {
        let negated = pattern.starts_with('!');
        let p = pattern.trim_start_matches('!').to_lowercase();
        // OpenSSH Host supports only * and ?; escape glob's character classes.
        let p: String = p
            .chars()
            .map(|c| match c {
                '[' => "[[]".into(),
                ']' => "[]]".into(),
                c => c.to_string(),
            })
            .collect();
        if glob::Pattern::new(&p)?.matches(&host.to_lowercase()) {
            if negated {
                return Ok(false);
            }
            matched = true;
        }
    }
    Ok(matched)
}

fn resolve_file(
    path: &Path,
    home: &Path,
    host: &str,
    active: &mut bool,
    depth: usize,
    values: &mut BTreeMap<String, String>,
    identities: &mut Vec<String>,
) -> Result<()> {
    if depth > 16 {
        bail!("Include 遞迴超過 16 層");
    }
    for (i, line) in content(path)?.unwrap_or_default().lines().enumerate() {
        let t = tokens(line).with_context(|| format!("{}:{}", path.display(), i + 1))?;
        if t.is_empty() {
            continue;
        }
        if t.len() < 2 {
            bail!("{}:{} 缺少設定值", path.display(), i + 1);
        }
        let key = t[0].to_ascii_lowercase();
        match key.as_str() {
            "host" => *active = matches_host(&t[1..], host)?,
            "match" => bail!(
                "{}:{}：目前連線解析不支援 Match；請使用手動連線",
                path.display(),
                i + 1
            ),
            "include" if *active => {
                for value in &t[1..] {
                    for p in includes(value, home)? {
                        resolve_file(&p, home, host, active, depth + 1, values, identities)?;
                    }
                }
            }
            "include" => {}
            _ if !*active => {}
            "hostname" | "user" | "port" => {
                if t.len() != 2 {
                    bail!("{}:{}：設定值數量錯誤", path.display(), i + 1);
                }
                values.entry(key).or_insert_with(|| t[1].clone());
            }
            "identityfile" => {
                if t.len() != 2 {
                    bail!("IdentityFile 路徑含空白時請加引號");
                }
                if t[1] != "none" && !identities.contains(&t[1]) {
                    identities.push(t[1].clone());
                }
            }
            _ => bail!(
                "{}:{}：轉發尚未支援設定 {}，請使用手動連線",
                path.display(),
                i + 1,
                t[0]
            ),
        }
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ResolvedHost {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_files: Vec<String>,
}

#[tauri::command]
pub fn resolve_ssh_host(alias: String) -> Result<ResolvedHost, String> {
    (|| -> Result<_> {
        if alias.trim().is_empty() || alias.contains(['\n', '\r', '\0']) {
            bail!("無效的 Host");
        }
        let home = home()?;
        let mut entries = Vec::new();
        read_tree(&path("config")?, &home, 0, &mut entries)?;
        if !entries
            .iter()
            .any(|entry| entry.name.eq_ignore_ascii_case(&alias))
        {
            bail!("找不到此 Host 別名，設定可能已被修改；請重新載入清單");
        }
        let mut values = BTreeMap::new();
        let mut identities = Vec::new();
        resolve_file(
            &path("config")?,
            &home,
            &alias,
            &mut true,
            0,
            &mut values,
            &mut identities,
        )?;
        let host = values
            .remove("hostname")
            .unwrap_or_else(|| alias.clone())
            .replace("%h", &alias);
        if host.contains('%') || host.trim().is_empty() {
            bail!("不支援的 HostName 展開");
        }
        let user = values
            .remove("user")
            .or_else(|| std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).ok())
            .context("請設定 User")?;
        let port = values
            .remove("port")
            .unwrap_or_else(|| "22".into())
            .parse::<u16>()?;
        if port == 0 {
            bail!("Port 不可為 0");
        }
        let mut identity_files = Vec::new();
        for value in identities {
            let mut expanded = String::new();
            let mut chars = value.chars();
            while let Some(c) = chars.next() {
                if c != '%' {
                    expanded.push(c);
                    continue;
                }
                match chars.next() {
                    Some('%') => expanded.push('%'),
                    Some('d') => expanded.push_str(&home.to_string_lossy()),
                    Some('h') => expanded.push_str(&host),
                    Some('r') => expanded.push_str(&user),
                    Some('p') => expanded.push_str(&port.to_string()),
                    Some('n') => expanded.push_str(&alias),
                    _ => bail!("不支援的 IdentityFile token"),
                }
            }
            identity_files.push(expand_home(&expanded, &home)?.display().to_string());
        }
        Ok(ResolvedHost {
            host,
            port,
            user,
            identity_files,
        })
    })()
    .map_err(|e| format!("{e:#}"))
}

#[derive(Serialize)]
pub struct KnownHost {
    line: usize,
    hosts: String,
    algorithm: String,
    fingerprint: String,
    marker: String,
    error: Option<String>,
}

fn known_entries(text: &str) -> Vec<KnownHost> {
    text.lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let mut fields = line.split_whitespace();
            let first = fields.next().unwrap_or("");
            let (marker, hosts) = if first.starts_with('@') {
                (first, fields.next().unwrap_or(""))
            } else {
                ("", first)
            };
            let algorithm = fields.next().unwrap_or("");
            let encoded = fields.next().unwrap_or("");
            let key =
                russh::keys::ssh_key::PublicKey::from_openssh(&format!("{algorithm} {encoded}"));
            let (fingerprint, error) = match key {
                Ok(k) => (
                    k.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                        .to_string(),
                    None,
                ),
                Err(e) => (String::new(), Some(e.to_string())),
            };
            Some(KnownHost {
                line: i,
                hosts: hosts.to_string(),
                algorithm: algorithm.to_string(),
                fingerprint,
                marker: marker.to_string(),
                error,
            })
        })
        .collect()
}

#[tauri::command]
pub fn known_host_entries(text: String) -> Vec<KnownHost> {
    known_entries(&text)
}

fn lookup(host: &str, port: u16) -> Result<String> {
    if host.trim().is_empty()
        || host.starts_with('-')
        || host.contains(['\n', '\r', '\0'])
        || port == 0
    {
        bail!("請輸入有效主機與 Port");
    }
    Ok(if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    })
}

fn keygen(args: &[&str], path: &Path) -> Result<std::process::Output> {
    let mut command = Command::new("ssh-keygen");
    command.args(args).arg("-f").arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .output()
        .context("無法執行 ssh-keygen，請安裝 OpenSSH Client")
}

fn find_lines(path: &Path, host: &str, port: u16) -> Result<Vec<usize>> {
    let output = keygen(&["-F", &lookup(host, port)?], path)?;
    if !output.status.success() && (output.status.code() != Some(1) || !output.stderr.is_empty()) {
        bail!("查詢失敗：{}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            line.strip_prefix("# Host ")?
                .rsplit_once("found: line ")?
                .1
                .split_whitespace()
                .next()?
                .parse::<usize>()
                .ok()?
                .checked_sub(1)
        })
        .collect())
}

fn remove_lines(text: &str, indices: &[usize]) -> String {
    text.split_inclusive('\n')
        .enumerate()
        .filter(|(i, _)| !indices.contains(i))
        .map(|(_, line)| line)
        .collect()
}

#[tauri::command]
pub fn find_known_host(
    host: String,
    port: u16,
    expected: Option<String>,
    kind: Option<String>,
    app: AppHandle,
) -> Result<Vec<usize>, String> {
    (|| -> Result<_> {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("檔案鎖定失敗"))?;
        let kind = kind.as_deref().unwrap_or("known_hosts");
        if !matches!(kind, "known_hosts" | "app_known_hosts") {
            bail!("不支援的信任檔案");
        }
        let path = managed_path(kind, &app)?;
        if content(&path)? != expected {
            bail!("檔案已變更，請重新載入");
        }
        if expected.is_none() {
            return Ok(Vec::new());
        }
        let lines = find_lines(&path, &host, port)?;
        if content(&path)? != expected {
            bail!("查詢時檔案已變更，請重新載入");
        }
        Ok(lines)
    })()
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn change_known_hosts(
    expected: Option<String>,
    action: String,
    line: Option<usize>,
    host: Option<String>,
    port: Option<u16>,
    kind: Option<String>,
    app: AppHandle,
) -> Result<Document, String> {
    (|| -> Result<_> {
        let _guard = FILE_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("檔案鎖定失敗"))?;
        let kind = kind.as_deref().unwrap_or("known_hosts");
        if !matches!(kind, "known_hosts" | "app_known_hosts") {
            bail!("不支援的信任檔案");
        }
        let path = managed_path(kind, &app)?;
        if content(&path)? != expected {
            bail!("檔案已變更，請重新載入");
        }
        let text = expected.as_deref().unwrap_or("");
        let changed = match action.as_str() {
            "clear" => String::new(),
            "delete" => {
                let index = line.context("缺少記錄行號")?;
                if !known_entries(text).iter().any(|entry| entry.line == index) {
                    bail!("找不到記錄");
                }
                remove_lines(text, &[index])
            }
            "reset" => {
                if expected.is_none() {
                    bail!("known_hosts 不存在");
                }
                let lines = find_lines(
                    &path,
                    &host.context("缺少主機")?,
                    port.context("缺少 Port")?,
                )?;
                if lines.is_empty() {
                    bail!("找不到此主機與 Port 的記錄，未修改檔案");
                }
                remove_lines(text, &lines)
            }
            _ => bail!("不支援的操作"),
        };
        save(&path, &expected, &changed)
    })()
    .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_tokens_and_validation() {
        assert_eq!(
            tokens("IdentityFile = \"C:\\my keys\\id\" # comment").unwrap(),
            ["IdentityFile", "C:\\my keys\\id"]
        );
        assert!(tokens("Host \"oops").is_err());
        assert!(validate("Host dev\n Port 0").is_err());
        assert!(matches_host(&["*".into(), "!prod*".into()], "dev").unwrap());
        assert!(!matches_host(&["*".into(), "!prod*".into()], "prod-db").unwrap());
    }
    #[test]
    fn saves_detect_conflicts_and_preserve_backup() {
        let dir = std::env::temp_dir().join(format!("ssh-gui-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config");
        let _ = fs::remove_file(&path);
        save(&path, &None, "# original\r\nHost dev\r\n").unwrap();
        let before = content(&path).unwrap();
        save(&path, &before, "Host new\n").unwrap();
        assert_eq!(content(&backup_path(&path)).unwrap(), before);
        assert!(save(&path, &before, "overwrite").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn include_order_and_unsupported_options() {
        let dir = std::env::temp_dir().join(format!("ssh-gui-resolve-{}", std::process::id()));
        fs::create_dir_all(dir.join(".ssh")).unwrap();
        fs::write(dir.join(".ssh/extra"), "Host dev\n User alice\n").unwrap();
        let path = dir.join(".ssh/config");
        fs::write(
            &path,
            "Include extra\nHost dev\n HostName example.com\n Port 2222\nHost *\n User fallback\n",
        )
        .unwrap();
        let mut values = BTreeMap::new();
        resolve_file(
            &path,
            &dir,
            "dev",
            &mut true,
            0,
            &mut values,
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(values["user"], "alice");
        assert_eq!(values["port"], "2222");
        fs::write(&path, "Host dev\n ProxyCommand anything\n").unwrap();
        assert!(resolve_file(
            &path,
            &dir,
            "dev",
            &mut true,
            0,
            &mut BTreeMap::new(),
            &mut Vec::new()
        )
        .is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_known_hosts_remain_visible() {
        let entries = known_entries("# comment\n\n@revoked host invalid broken\n");
        assert_eq!(entries[0].line, 2);
        assert_eq!(entries[0].marker, "@revoked");
        assert!(entries[0].error.is_some());
        assert_eq!(lookup("::1", 2222).unwrap(), "[::1]:2222");
    }
    #[test]
    fn keygen_finds_hashed_hosts_and_reset_preserves_other_lines() {
        let dir = std::env::temp_dir().join(format!("ssh-gui-known-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
        let original =
            format!("# preserve comment\r\n[example.test]:2222 {key}\r\nother.test {key}\r\n");
        fs::write(&path, &original).unwrap();
        assert_eq!(find_lines(&path, "example.test", 2222).unwrap(), [1]);
        assert!(find_lines(&path, "example.test", 22).unwrap().is_empty());
        assert!(keygen(&["-H"], &path).unwrap().status.success());
        let hashed = fs::read_to_string(&path).unwrap();
        assert!(hashed.contains("|1|"));
        let lines = find_lines(&path, "example.test", 2222).unwrap();
        assert_eq!(lines, [1]);
        let changed = remove_lines(&hashed, &lines);
        save(&path, &Some(hashed.clone()), &changed).unwrap();
        assert!(find_lines(&path, "example.test", 2222).unwrap().is_empty());
        assert_eq!(find_lines(&path, "other.test", 22).unwrap(), [1]);
        assert_eq!(content(&backup_path(&path)).unwrap(), Some(hashed));
        assert_eq!(
            remove_lines(&original, &[1]),
            format!("# preserve comment\r\nother.test {key}\r\n")
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
