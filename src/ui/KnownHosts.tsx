import { useEffect, useState } from "react";
import { Card, Chip, Table } from "@heroui/react";
import { FileKey2, Fingerprint, FolderOpen, Info, LockKeyhole, RefreshCw, RotateCcw, Search, Server, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../component/Button";
import Input from "../component/Input";
import Select from "../component/Select";
import { useConfirmation } from "../component/useConfirmation";
import { errorText, SshDocument } from "./ssh";

type Entry = { line: number; hosts: string; algorithm: string; fingerprint: string; marker: string; error: string | null };

export default function KnownHosts() {
  const [kind, setKind] = useState("known_hosts");
  const [doc, setDoc] = useState<SshDocument>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [matches, setMatches] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { confirm, dialog } = useConfirmation();

  async function apply(result: SshDocument) {
    setDoc(result); setMatches(null);
    setEntries(await invoke<Entry[]>("known_host_entries", { text: result.content ?? "" }));
  }
  async function load() {
    setBusy(true); setMessage("");
    try { await apply(await invoke<SshDocument>("read_ssh_file", { kind })); }
    catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  useEffect(() => { setDoc(undefined); setEntries([]); setMatches(null); void load(); }, [kind]);
  async function find() {
    if (!doc) return;
    setBusy(true); setMessage("");
    try {
      const result = await invoke<number[]>("find_known_host", { kind, expected: doc.content, host, port: Number(port) });
      setMatches(result); setMessage(`找到 ${result.length} 筆符合的記錄。`);
    } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function change(action: "clear" | "reset" | "delete", entry?: Entry) {
    if (!doc) return;
    setBusy(true); setMessage("");
    try {
      let details = entry ? `第 ${entry.line + 1} 行：${entry.hosts}\n${entry.fingerprint}` : "";
      if (action === "reset") {
        const lines = await invoke<number[]>("find_known_host", { kind, expected: doc.content, host, port: Number(port) });
        if (!lines.length) { setMessage("找不到此主機與 Port 的記錄，未修改檔案。"); return; }
        details = entries.filter(e => lines.includes(e.line)).map(e => `第 ${e.line + 1} 行：${e.hosts}\n${e.fingerprint}`).join("\n\n");
      }
      if (!await confirm({
        title: action === "clear" ? "清空所有信任記錄？" : action === "reset" ? `重置 ${host}:${port}？` : "刪除此筆主機金鑰？",
        description: action === "clear" ? `這會移除所選檔案的全部 ${entries.length} 筆記錄。下次連線需重新核對主機身分，目前內容將先備份。` : "同一行的所有主機別名都會一起移除。下次連線請重新核對金鑰指紋，目前內容將先備份。",
        details, danger: true, phrase: action === "clear" ? "RESET" : undefined,
        confirmLabel: action === "reset" ? "重置信任" : action === "clear" ? "清空所有記錄" : "刪除記錄",
      })) return;
      const result = await invoke<SshDocument>("change_known_hosts", { kind, expected: doc.content, action, line: entry?.line ?? null, host, port: Number(port) });
      await apply(result); setMessage("已更新並備份上一版本。重置只移除信任，不會自動信任新金鑰。");
    } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function restore() {
    if (!doc || !await confirm({ title: "還原上一份信任記錄？", description: "目前內容會先備份，再還原上一版本的 Known Hosts。", confirmLabel: "還原記錄" })) return;
    setBusy(true);
    try { await apply(await invoke<SshDocument>("restore_ssh_file", { kind, expected: doc.content })); setMessage("已還原上一版本。"); }
    catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  const validLookup = !!host.trim() && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
  const visibleEntries = entries.filter(entry => matches === null || matches.includes(entry.line));

  return <section aria-label="Known Hosts">
    <div className="page-heading"><div><div className="eyebrow">TRUSTED IDENTITIES</div><h1>Known Hosts</h1><p>核對每一個主機身分，管理已儲存的 SSH 信任記錄。</p></div>
      <div className="heading-actions"><Button text="還原備份" icon={<RotateCcw size={13} />} disable={busy || !doc?.backup} onClick={() => void restore()} /><Button text="重新載入" icon={<RefreshCw size={13} />} disable={busy} onClick={() => void load()} /></div>
    </div>
    <Card className="panel known-toolbar"><div className="panel-header"><h2 className="panel-title"><FolderOpen size={16} />信任檔案</h2><Chip size="sm" variant="soft">{kind === "app_known_hosts" ? "APP STORAGE" : "USER STORAGE"}</Chip></div>
      <div className="panel-body"><div className="fields-grid"><Select label="檔案來源" value={kind} onChange={setKind} disabled={busy} options={[{ id: "app_known_hosts", label: "本程式的 Known Hosts" }, { id: "known_hosts", label: "使用者 ~/.ssh/known_hosts" }]} /><div className="flex items-end"><div className="file-location w-full mb-0"><FileKey2 size={15} /><code>{doc?.path ?? "正在讀取…"}</code></div></div></div>
        <div className="known-filter mt-5"><Input label="查詢主機名稱 / IP" value={host} placeholder="example.com 或 IP 位址" disabled={busy} onChange={value => { setHost(value); setMatches(null); }} /><Input label="Port" value={port} placeholder="22" disabled={busy} onChange={value => { setPort(value); setMatches(null); }} />
          <div className="lookup-buttons"><Button text="查詢" icon={<Search size={14} />} variant="primary" disable={busy || !doc || !validLookup} onClick={() => void find()} /><Button text="重置信任" icon={<RotateCcw size={13} />} danger disable={busy || !doc || !validLookup} onClick={() => void change("reset")} /></div>
        </div><p className="muted mt-3 text-[10px] flex items-center gap-1.5"><Info size={12} />查詢也支援雜湊主機。重置後，請再次確認新金鑰的來源。</p>
      </div>
    </Card>
    {message && <div role="status" className="notice"><Info size={15} /><span>{message}</span></div>}
    <Card className="panel"><div className="panel-header"><h2 className="panel-title"><ShieldCheck size={16} />主機金鑰 <Chip size="sm" variant="soft">{entries.length}</Chip></h2><div className="toolbar">{matches !== null ? <Button text="顯示全部記錄" variant="tertiary" onClick={() => setMatches(null)} /> : <span className="muted">SHA256 指紋</span>}</div></div>
      <Table className="trust-table-root"><Table.ScrollContainer><Table.Content className="trust-table" aria-label="已儲存的 SSH 主機金鑰">
        <Table.Header><Table.Column id="host" isRowHeader>主機</Table.Column><Table.Column id="type">金鑰類型</Table.Column><Table.Column id="fingerprint">指紋</Table.Column><Table.Column id="action">操作</Table.Column></Table.Header>
        <Table.Body renderEmptyState={() => <div className="empty-state"><Fingerprint size={36} /><strong>{busy ? "正在讀取信任記錄…" : matches !== null ? "沒有符合的記錄" : "尚未儲存主機金鑰"}</strong><p>{matches !== null ? "確認主機名稱與 Port，或顯示全部記錄。" : "信任並連線至 SSH 主機後，金鑰會出現在這裡。"}</p></div>}>
          {visibleEntries.map(entry => <Table.Row key={entry.line} id={entry.line} textValue={entry.hosts}>
            <Table.Cell><div className="trust-host"><span className="host-item-icon">{entry.hosts.startsWith("|1|") ? <LockKeyhole size={15} /> : <Server size={15} />}</span><span><strong>{entry.hosts.startsWith("|1|") ? "已雜湊的主機" : entry.hosts}</strong><small>第 {entry.line + 1} 行{entry.hosts.startsWith("|1|") ? " · 以主機名稱查詢" : ""}</small></span></div></Table.Cell>
            <Table.Cell><Chip size="sm" variant="soft" color={entry.error ? "warning" : "default"}>{entry.algorithm || "無法辨識"}</Chip>{entry.marker && <div className="muted text-[9px] mt-1">{entry.marker}</div>}</Table.Cell>
            <Table.Cell><code className="fingerprint">{entry.fingerprint || "—"}</code>{entry.error && <p className="text-danger text-[10px] mt-1">無法解析：{entry.error}</p>}</Table.Cell>
            <Table.Cell><Button text="刪除" icon={<Trash2 size={12} />} danger disable={busy} onClick={() => void change("delete", entry)} /></Table.Cell>
          </Table.Row>)}
        </Table.Body>
      </Table.Content></Table.ScrollContainer></Table>
      <div className="panel-footer"><span className="muted">{doc?.content === null ? "檔案尚未建立" : `顯示 ${visibleEntries.length} / ${entries.length} 筆記錄`}</span><span className="muted flex items-center gap-1.5"><ShieldCheck size={12} />修改前自動備份</span></div>
    </Card>
    <div className="danger-zone"><div><h3 className="flex items-center gap-2"><ShieldOff size={14} />重置全部信任</h3><p>清空目前所選的信任檔案，所有主機將需要重新確認身分。</p></div><Button text="清空所有記錄" danger icon={<Trash2 size={13} />} disable={busy || !entries.length} onClick={() => void change("clear")} /></div>
    {dialog}
  </section>;
}
