import { useState, useEffect } from "react";
import { Card, Chip, Modal } from "@heroui/react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Cable, CircleAlert, Info, KeyRound, Laptop, LockKeyhole, Network, Play, Server, ShieldCheck, Square, Activity } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ConnectStatus, useForward } from "../hooks/useForward";
import TransferChart from "./TransferChart";
import Input from "../component/Input";
import Select from "../component/Select";
import Toast from "../component/Toast";
import Button from "../component/Button";
import { HostEntry, ResolvedHost, errorText } from "./ssh";

function Forward({ revision = 0, active = true }: { revision?: number; active?: boolean } = {}) {
  const [localIP, setLocalIP] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState("5678");
  const [ip, setIP] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const { connectStatus, errorMsg, numberOfConnect, chartData, showErrorMsg, invokeForward, invokeStop, hostKey, trustHost, rejectHost } = useForward();
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [alias, setAlias] = useState("");
  const [resolved, setResolved] = useState<ResolvedHost>();
  const [identityFile, setIdentityFile] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("5432");
  const [configError, setConfigError] = useState("");
  const connected = connectStatus === ConnectStatus.Connected;
  const busy = connectStatus === ConnectStatus.Connecting || connectStatus === ConnectStatus.Stopping;
  const editable = connectStatus === ConnectStatus.Disconnected;
  const status = connected ? "連線中" : connectStatus === ConnectStatus.Connecting ? "建立連線中" : connectStatus === ConnectStatus.Stopping ? "停止中" : "尚未連線";

  useEffect(() => {
    if (!active || !editable) return;
    let disposed = false;
    invoke<HostEntry[]>("ssh_hosts").then(result => { if (!disposed) setHosts(result ?? []); }).catch(e => { if (!disposed) setConfigError(errorText(e)); });
    return () => { disposed = true; };
  }, [revision, active, editable]);
  useEffect(() => {
    if (!active || !editable) return;
    let disposed = false;
    setResolved(undefined); setConfigError("");
    if (alias) invoke<ResolvedHost>("resolve_ssh_host", { alias }).then(result => {
      if (!disposed) setResolved(result);
    }).catch(e => { if (!disposed) setConfigError(errorText(e)); });
    return () => { disposed = true; };
  }, [alias, revision, active, editable]);
  useEffect(() => {
    if (connected) { setPassword(""); setPassphrase(""); }
  }, [connected]);

  const hostOptions = [{ id: "manual", label: "手動輸入連線資訊" }, ...[...new Set(hosts.map(host => host.name))].map(name => ({ id: `host:${name}`, label: name }))];
  if (alias && !hosts.some(host => host.name === alias)) hostOptions.push({ id: `host:${alias}`, label: `${alias}（設定已變更）` });
  const sshHost = alias ? resolved?.host ?? alias : ip;
  const sshPort = alias ? resolved?.port ?? 22 : port;
  const sshUser = alias ? resolved?.user : user;
  const identity = alias ? resolved?.identity_files.join(", ") : identityFile;
  const sent = chartData.datasets[0].data.slice(-1)[0] ?? 0;
  const received = chartData.datasets[1].data.slice(-1)[0] ?? 0;
  const rate = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  const validPort = (value: string) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;

  return <section aria-label="連接埠轉發">
    <div className="page-heading"><div><div className="eyebrow">PORT FORWARDING</div><h1>連接埠轉發</h1><p>透過 SSH，把遠端服務連接到你的本機。</p></div>
      <span role="status" className={`status-pill ${connected ? "connected" : busy ? "busy" : ""}`}><span className="status-dot" />{status}</span>
    </div>
    <div className="route-strip" aria-label="轉發連線路徑">
      <div className="route-node"><span className="route-icon"><Laptop size={17} /></span><div><small>本機監聽</small><code>{localIP || "localhost"}:{localPort || "—"}</code></div></div>
      <ArrowRight className="route-arrow" size={16} />
      <div className="route-node"><span className="route-icon"><ShieldCheck size={17} /></span><div><small>SSH 安全通道</small><code>{sshHost ? `${sshHost}:${sshPort}` : "尚未設定伺服器"}</code></div></div>
      <ArrowRight className="route-arrow" size={16} />
      <div className="route-node"><span className="route-icon"><Server size={17} /></span><div><small>轉發目的地</small><code>{targetHost || "—"}:{targetPort || "—"}</code></div></div>
    </div>
    <div className="forward-layout">
      <form onSubmit={e => {
        e.preventDefault();
        if (connected) { void invokeStop(); return; }
        if (!editable) return;
        const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
        if (!ipv4.test(localIP)) { showErrorMsg("請輸入有效的本機 IPv4 位址"); return; }
        if (!validPort(localPort)) { showErrorMsg("本機 Port 必須介於 1–65535"); return; }
        if (!alias && (!ip.trim() || /[\r\n\0]/.test(ip))) { showErrorMsg("請輸入 SSH 主機名稱或 IP"); return; }
        if (!alias && !validPort(port)) { showErrorMsg("SSH Port 必須介於 1–65535"); return; }
        if (!alias && !user.trim()) { showErrorMsg("請輸入 SSH 使用者名稱"); return; }
        if (alias && !resolved) { showErrorMsg(configError || "正在解析 SSH Config"); return; }
        if (!targetHost.trim() || !validPort(targetPort)) { showErrorMsg("請輸入有效的轉發目的主機與 Port"); return; }
        if (!password && !identity) { showErrorMsg("請輸入密碼或指定私鑰"); return; }
        void invokeForward({ localIp: localIP, localPort: Number(localPort), remoteIp: ip, remotePort: Number(port), user, password, alias: alias || null, identityFile: identityFile || null, passphrase, targetHost, targetPort: Number(targetPort) });
      }}>
        <Card className="panel">
          <div className="panel-header"><h2 className="panel-title"><Cable size={16} />連線設定</h2><Chip size="sm" variant="soft">LOCAL FORWARD</Chip></div>
          <div className="panel-body">
            <fieldset aria-label="本機監聽" className="field-section" disabled={!editable}><div className="section-label"><span className="step-number">01</span>本機監聽<small>LOCAL ENDPOINT</small></div>
              <div className="fields-grid"><Input label="本機 IP" value={localIP} placeholder="127.0.0.1" onChange={setLocalIP} disabled={!editable} /><Input label="本機 Port" value={localPort} placeholder="5678" onChange={setLocalPort} disabled={!editable} /></div>
            </fieldset>
            <fieldset aria-label="SSH 伺服器" className="field-section" disabled={!editable}><div className="section-label"><span className="step-number">02</span>SSH 伺服器<small>SECURE GATEWAY</small></div>
              <Select label="連線來源" value={alias ? `host:${alias}` : "manual"} options={hostOptions} disabled={!editable} onChange={value => { setAlias(value === "manual" ? "" : value.slice(5)); setPassword(""); setPassphrase(""); }} />
              {configError && <p role="alert" className="notice error" style={{ marginTop: 12 }}><CircleAlert size={15} />{configError}</p>}
              {alias ? <div className="resolved-host"><Server size={15} /><span>{resolved ? `${resolved.user}@${resolved.host}:${resolved.port}` : "正在讀取主機設定…"}{identity && <small className="block muted">{identity}</small>}</span></div> : <div className="fields-grid mt-4">
                <Input label="主機名稱 / IP" value={ip} placeholder="server.example.com" onChange={setIP} disabled={!editable} /><Input label="SSH Port" value={port} placeholder="22" onChange={setPort} disabled={!editable} />
                <Input label="使用者名稱" value={user} placeholder="root" onChange={setUser} disabled={!editable} /><Input label="私鑰路徑（選填）" value={identityFile} placeholder="~/.ssh/id_ed25519" onChange={setIdentityFile} disabled={!editable} />
              </div>}
              <div className="fields-grid mt-4"><Input label="登入密碼" value={password} placeholder={identity ? "使用私鑰時可留空" : "輸入 SSH 密碼"} type="password" onChange={setPassword} disabled={!editable} /><Input label="私鑰密語（選填）" value={passphrase} placeholder="加密私鑰使用" type="password" onChange={setPassphrase} disabled={!editable} /></div>
            </fieldset>
            <fieldset aria-label="轉發目的地" className="field-section" disabled={!editable}><div className="section-label"><span className="step-number">03</span>轉發目的地<small>REMOTE SERVICE</small></div>
              <div className="fields-grid"><Input label="目的主機" value={targetHost} placeholder="127.0.0.1" onChange={setTargetHost} disabled={!editable} /><Input label="目的 Port" value={targetPort} placeholder="5432" onChange={setTargetPort} disabled={!editable} /></div>
              <p className="muted mt-3 text-[10px]">由 SSH 伺服器連出，主機名稱也由遠端解析。</p>
            </fieldset>
          </div>
          <div className="panel-footer"><span className="muted flex items-center gap-1.5"><LockKeyhole size={12} />密碼與密語不會寫入設定檔</span><Button type="submit" text={connected ? "停止轉發" : busy ? status : "建立連線"} variant="primary" danger={connected} disable={busy} icon={connected ? <Square size={13} /> : <Play size={13} />} /></div>
        </Card>
      </form>
      <aside className="monitor-column" aria-label="連線監看">
        <Card className="panel"><div className="panel-header"><h2 className="panel-title"><Activity size={16} />即時流量</h2><span className="muted">每秒更新</span></div>
          <div className="panel-body"><div className="metric-large">{connected ? numberOfConnect : "—"}<small>個連線</small></div><div className="metric-caption">目前作用中的 TCP 通道</div>
            <div className="traffic-metrics"><div><small><ArrowUpRight size={12} />傳送</small><strong>{connected ? rate(sent) : "0.0 KB"}<span>/s</span></strong></div><div><small><ArrowDownLeft size={12} />接收</small><strong>{connected ? rate(received) : "0.0 KB"}<span>/s</span></strong></div></div>
            <div className="chart-legend"><span><i className="legend-line" />傳送</span><span><i className="legend-line recv" />接收</span></div><div className="chart-wrap"><TransferChart data={chartData} /></div>
          </div>
        </Card>
        <Card className="panel"><div className="panel-header"><h2 className="panel-title"><Network size={16} />連線摘要</h2><KeyRound size={14} className="muted" /></div>
          <div className="panel-body"><dl className="session-details"><div><dt>SSH 主機</dt><dd className="mono">{sshHost || "尚未設定"}</dd></div><div><dt>使用者</dt><dd className="mono">{sshUser || "—"}</dd></div><div><dt>驗證方式</dt><dd>{identity ? "SSH 私鑰" : "密碼"}</dd></div><div><dt>設定來源</dt><dd>{alias || "手動輸入"}</dd></div><div><dt>轉發類型</dt><dd>本機 → 遠端</dd></div></dl>
            <div className="tip-box"><Info size={14} /><p>首次連線時，請核對伺服器金鑰指紋後再信任。</p></div>
          </div>
        </Card>
      </aside>
    </div>
    <Modal.Backdrop isOpen={!!hostKey} isDismissable={false} onOpenChange={open => { if (!open) rejectHost(); }}><Modal.Container size="md"><Modal.Dialog>
      <Modal.Header><div className="modal-symbol"><ShieldCheck /></div><Modal.Heading>確認 SSH 主機身分</Modal.Heading></Modal.Header>
      <Modal.Body><p className="muted">首次連線至 <strong>{hostKey?.host}:{hostKey?.port}</strong>。請向伺服器管理者核對以下指紋。</p><pre className="confirmation-details">{hostKey?.fingerprint}</pre><p className="muted">確認後將儲存此主機金鑰，再繼續登入。</p></Modal.Body>
      <Modal.Footer><Button text="取消連線" variant="tertiary" onClick={rejectHost} /><Button text="信任並連線" variant="primary" icon={<ShieldCheck size={15} />} onClick={() => void trustHost()} /></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop>
    <Toast hidden={!errorMsg} message={errorMsg} />
  </section>;
}

export default Forward;
