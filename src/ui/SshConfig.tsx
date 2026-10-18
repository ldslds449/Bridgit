import { useEffect, useState } from "react";
import { Button as HeroButton, Card, Chip, Modal } from "@heroui/react";
import { Check, ChevronRight, Code2, FileCode2, FileText, FolderOpen, Info, Plus, RefreshCw, RotateCcw, Save, Search, Server, SlidersHorizontal, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../component/Button";
import Input from "../component/Input";
import CodeEditor from "../component/CodeEditor";
import { useConfirmation } from "../component/useConfirmation";
import { emptyHost, errorText, hostBlocks, HostEntry, SshDocument, simpleHost, updateSimpleHost } from "./ssh";

const placeholders: Record<string, string> = { Host: "例如 production", HostName: "server.example.com", User: "root", Port: "22", IdentityFile: "~/.ssh/id_ed25519" };
const labels: Record<string, string> = { Host: "Host 別名", HostName: "主機名稱 / IP", User: "使用者名稱", Port: "SSH Port", IdentityFile: "私鑰路徑（選填）" };

export default function SshConfig({ onChanged }: { onChanged: () => void }) {
  const [doc, setDoc] = useState<SshDocument>();
  const [text, setText] = useState("");
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [blockText, setBlockText] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyHost);
  const [editingForm, setEditingForm] = useState<typeof emptyHost | null>(null);
  const [view, setView] = useState<"form" | "code" | "source">("source");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { confirm, dialog } = useConfirmation();
  const blocks = hostBlocks(text);
  const current = selected !== null ? blocks[selected] : undefined;
  const editorDirty = !!current && (blockText !== current.text || (editingForm !== null && JSON.stringify(editingForm) !== JSON.stringify(simpleHost(blockText))));
  const dirty = text !== (doc?.content ?? "");
  const pending = dirty || editorDirty;
  const included = hosts.filter(h => h.source !== doc?.path);

  function select(index: number, source: string) {
    const block = hostBlocks(source)[index];
    setSelected(block ? index : null); setBlockText(block?.text ?? "");
    const simple = block ? simpleHost(block.text) : null;
    setEditingForm(simple); setView(block ? simple ? "form" : "code" : "source");
  }
  async function selectBlock(index: number) {
    if (index === selected && view !== "source") return;
    if (editorDirty && !await confirm({ title: "放棄目前的區塊修改？", description: "此區塊尚未套用至草稿，切換後會放棄這些修改。", confirmLabel: "放棄並切換" })) return;
    select(index, text);
  }
  async function refreshHosts() {
    try { setHosts(await invoke<HostEntry[]>("ssh_hosts")); }
    catch (e) { setHosts([]); setMessage(`清單解析失敗，仍可編輯原文：${errorText(e)}`); }
  }
  async function load() {
    if (pending && !await confirm({ title: "重新載入設定？", description: "尚未儲存的草稿與區塊修改將被放棄。", confirmLabel: "重新載入" })) return;
    setBusy(true); setMessage("");
    try {
      const result = await invoke<SshDocument>("read_ssh_file", { kind: "config" });
      setDoc(result); setText(result.content ?? ""); select(0, result.content ?? ""); setPreview(false);
      await refreshHosts();
    } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (pending) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pending]);

  async function save() {
    if (!doc) return;
    setBusy(true); setMessage("");
    try {
      const result = await invoke<SshDocument>("save_ssh_file", { kind: "config", expected: doc.content, text });
      setDoc(result); setText(result.content ?? ""); setPreview(false); select(0, result.content ?? "");
      setMessage("已儲存，上一版本已備份。"); await refreshHosts(); onChanged();
    } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  async function restore() {
    if (!doc || !await confirm({ title: "還原上一份備份？", description: "目前檔案會先備份。尚未儲存的編輯將被放棄。", confirmLabel: "還原設定" })) return;
    setBusy(true);
    try {
      const result = await invoke<SshDocument>("restore_ssh_file", { kind: "config", expected: doc.content });
      setDoc(result); setText(result.content ?? ""); select(0, result.content ?? ""); setPreview(false);
      setMessage("已還原上一版本。"); await refreshHosts(); onChanged();
    } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  function validForm(value: typeof emptyHost) {
    if (!value.Host.trim()) { setMessage("請填寫 Host 別名。"); return false; }
    if (!/^[a-zA-Z0-9._-]+$/.test(value.Host) || (value.Port !== "" && (Number(value.Port) < 1 || Number(value.Port) > 65535 || !/^\d+$/.test(value.Port)))) {
      setMessage("Host 請使用單一別名；Port 必須介於 1–65535。"); return false;
    }
    if (Object.values(value).some(v => /[\r\n\0"'#]/.test(v))) { setMessage("欄位不可含換行、引號、# 或 NUL；複雜設定請用原文編輯。"); return false; }
    if (/\s/.test(value.HostName) || /\s/.test(value.User)) { setMessage("HostName 與 User 不可含空白。"); return false; }
    return true;
  }
  function applyBlock() {
    if (!current || selected === null) return text;
    if (view === "form" && editingForm && !validForm(editingForm)) return null;
    const updated = view === "form" && editingForm ? updateSimpleHost(blockText, editingForm) : blockText;
    const suffix = current.end < text.length && updated && !updated.endsWith("\n") ? (text.includes("\r\n") ? "\r\n" : "\n") : "";
    const next = text.slice(0, current.start) + updated + suffix + text.slice(current.end);
    setText(next); select(selected, next);
    return next;
  }
  function previewSave() {
    if (editorDirty && applyBlock() === null) return;
    setPreview(true);
  }
  async function deleteBlock() {
    if (!current) return;
    if (!await confirm({ title: `刪除 ${current.name}？`, description: "此區塊會從草稿移除，儲存後才會寫入檔案。", details: current.text, danger: true, confirmLabel: "刪除區塊" })) return;
    const next = text.slice(0, current.start) + text.slice(current.end);
    setText(next); select(0, next); setPreview(false);
  }
  function addHost() {
    if (!validForm(form)) return;
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const entry = Object.entries(form).filter(([, value]) => value.trim()).map(([key, value]) => `${key === "Host" ? "" : "    "}${key} ${/\s/.test(value) ? `"${value}"` : value}${newline}`).join("");
    const pos = blocks[0]?.start ?? text.length;
    const prefix = text.slice(0, pos);
    const next = prefix + (prefix && !prefix.endsWith("\n") ? newline : "") + entry + newline + text.slice(pos);
    setText(next); select(0, next); setAdding(false); setForm(emptyHost); setPreview(false);
    setMessage("已加入草稿，儲存後即可在轉發頁選用。");
  }

  return <section aria-label="SSH Config">
    <div className="page-heading"><div><div className="eyebrow">HOST CONFIGURATION</div><h1>SSH Config</h1><p>把常用主機整理好，讓下一次連線更簡單。</p></div>
      <div className="heading-actions"><Button text="重新載入" icon={<RefreshCw size={13} />} disable={busy} onClick={() => void load()} /><Button text="新增主機" variant="primary" icon={<Plus size={14} />} disable={busy || !doc || editorDirty} onClick={() => { setForm(emptyHost); setAdding(true); }} /></div>
    </div>
    <div className="file-location"><FolderOpen size={15} /><code>{doc?.path ?? "正在讀取設定位置…"}</code><span>{doc?.content === null ? "首次儲存時建立" : "使用者設定檔"}</span></div>
    {message && <div role="status" className="notice"><Info size={15} /><span>{message}</span></div>}
    <div className="config-layout">
      <Card className="panel"><div className="panel-header"><h2 className="panel-title">主機清單</h2><Chip size="sm" variant="soft">{blocks.length}</Chip></div>
        <div className="host-list-header"><div className="flex items-center gap-2"><Search size={14} className="muted" /><Input label="搜尋主機" value={search} placeholder="別名、IP 或設定…" onChange={setSearch} /></div></div>
        <div className="host-list">{blocks.map((block, index) => {
          if (!block.text.toLowerCase().includes(search.toLowerCase())) return null;
          const info = simpleHost(block.text);
          return <HeroButton key={index} variant="ghost" className="host-item" data-selected={selected === index && view !== "source"} aria-pressed={selected === index && view !== "source"} isDisabled={busy} onPress={() => void selectBlock(index)}>
            <span className="host-item-icon">{info ? <Server size={15} /> : <Code2 size={15} />}</span><span className="host-item-text"><strong>{info?.Host ?? block.name}</strong><small>{info ? `${info.User ? `${info.User}@` : ""}${info.HostName || info.Host}${info.Port ? `:${info.Port}` : ""}` : "進階設定區塊"}</small></span><ChevronRight size={12} />
          </HeroButton>;
        })}
        {!blocks.length && <div className="empty-state"><Server size={28} /><strong>新增第一個主機</strong><p>常用連線會顯示在這裡。</p></div>}
        {blocks.length > 0 && !blocks.some(b => b.text.toLowerCase().includes(search.toLowerCase())) && <div className="empty-state"><Search size={24} /><p>找不到符合的設定</p></div>}
        </div>
        <div className="host-list-caption">{included.length ? `另有 ${included.length} 個引用主機` : "支援 Host 與 Include 引用設定"}</div>
        {included.filter(h => h.name.toLowerCase().includes(search.toLowerCase())).map((host, index) => <div key={index} className="include-host"><span className="flex items-center gap-2"><FileText size={12} />{host.name}<Chip size="sm" variant="soft">唯讀</Chip></span><small>{host.source}:{host.line}</small></div>)}
      </Card>
      <div className="editor-stack"><Card className="panel">
        <div className="panel-header"><h2 className="panel-title"><FileCode2 size={16} />{view === "source" ? "完整設定檔" : current?.name ?? "主機設定"}</h2>
          <div className="editor-tabs">{current && <><Button text="表單" icon={<SlidersHorizontal size={12} />} variant={view === "form" ? "secondary" : "tertiary"} disable={!editingForm || busy} onClick={() => setView("form")} /><Button text="區塊" icon={<Code2 size={12} />} variant={view === "code" ? "secondary" : "tertiary"} disable={busy} onClick={() => { if (view === "form" && editingForm) { if (!validForm(editingForm)) return; setBlockText(updateSimpleHost(blockText, editingForm)); } setView("code"); }} /></>}
            <Button text="完整原文" variant={view === "source" ? "secondary" : "tertiary"} disable={busy} onClick={() => { if (editorDirty && applyBlock() === null) return; setSelected(null); setView("source"); }} />
          </div>
        </div>
        <div className="panel-body">
          {view === "form" && editingForm ? <><div className="fields-grid">{Object.entries(editingForm).map(([key, value]) => <Input key={key} className={key === "IdentityFile" ? "wide" : undefined} label={labels[key]} value={value} placeholder={placeholders[key]} disabled={busy} onChange={v => setEditingForm(prev => prev && ({ ...prev, [key]: v }))} />)}</div>
            <div className="tip-box"><Info size={14} /><p>留空的欄位沿用其他設定。註解與未修改的內容會保留。</p></div></> : <CodeEditor label={view === "source" ? "~/.ssh/config" : current?.name ?? "SSH Config"} value={view === "source" ? text : blockText} disabled={busy || !doc} onChange={value => {
              if (view === "source") { setText(value); setSelected(null); setPreview(false); }
              else { setBlockText(value); setEditingForm(simpleHost(value)); }
            }} />}
          <div className="editor-status"><span>{pending ? "● 有尚未儲存的變更" : "所有變更已儲存"}</span><span>UTF-8 · {text.includes("\r\n") ? "CRLF" : "LF"}</span></div>
        </div>
        <div className="panel-footer"><div className="toolbar">{current && view !== "source" && <Button text="刪除主機" danger icon={<Trash2 size={12} />} disable={busy} onClick={() => void deleteBlock()} />}
          <Button text="還原備份" variant="tertiary" icon={<RotateCcw size={12} />} disable={busy || !doc?.backup} onClick={() => void restore()} /></div>
          <Button text="預覽並儲存" variant="primary" icon={<Save size={14} />} disable={busy || !pending || !doc} onClick={previewSave} />
        </div>
      </Card><p className="muted flex items-center gap-2 text-[10px]"><Check size={13} />儲存前自動備份；外部檔案有變更時會提醒你重新載入。</p></div>
    </div>
    <Modal.Backdrop isOpen={adding} isDismissable={!busy} onOpenChange={setAdding}><Modal.Container size="md"><Modal.Dialog><Modal.CloseTrigger /><Modal.Header><div className="modal-symbol"><Server /></div><Modal.Heading>新增 SSH 主機</Modal.Heading></Modal.Header>
      <Modal.Body><p className="muted mb-5">給主機一個好記的別名，之後就能直接選用。</p><div className="fields-grid">{Object.entries(form).map(([key, value]) => <Input key={key} className={key === "IdentityFile" ? "wide" : undefined} label={labels[key]} value={value} placeholder={placeholders[key]} onChange={v => setForm(prev => ({ ...prev, [key]: v }))} />)}</div><p role="status" className="muted mt-3">{message}</p></Modal.Body>
      <Modal.Footer><Button text="取消" variant="tertiary" onClick={() => setAdding(false)} /><Button text="加入草稿" variant="primary" icon={<Plus size={14} />} onClick={addHost} /></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop>
    <Modal.Backdrop isOpen={preview} isDismissable={!busy} onOpenChange={open => { if (!busy) setPreview(open); }}><Modal.Container size="lg"><Modal.Dialog><Modal.Header><Modal.Heading>確認設定變更</Modal.Heading><p className="muted">確認內容後儲存，原始檔案會先備份。</p></Modal.Header>
      <Modal.Body><div className="diff-grid"><div><h3>目前檔案</h3><pre>{doc?.content ?? "（尚未建立）"}</pre></div><div><h3>儲存後</h3><pre>{text || "（空白）"}</pre></div></div><p role="status" className="muted">{message}</p></Modal.Body>
      <Modal.Footer><Button text="繼續編輯" variant="tertiary" disable={busy} onClick={() => setPreview(false)} /><Button text={busy ? "儲存中…" : "確認儲存"} variant="primary" icon={<Save size={14} />} disable={busy} onClick={() => void save()} /></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop>
    {dialog}
  </section>;
}
