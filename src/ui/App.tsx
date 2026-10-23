import { useEffect, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { ArrowUpRight, ChevronRight, FileCode2, HardDrive, Moon, Network, ShieldCheck, Sun, Terminal } from "lucide-react";
import Forward from "./Forward";
import SshConfig from "./SshConfig";
import KnownHosts from "./KnownHosts";
import "./Manager.css";

const pages = [
  { id: "forward", label: "連接埠轉發", english: "Port forwarding", icon: Network },
  { id: "config", label: "SSH Config", english: "Host configuration", icon: FileCode2 },
  { id: "known", label: "Known Hosts", english: "Trusted identities", icon: ShieldCheck },
];

export default function App() {
  const [page, setPage] = useState("forward");
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const current = pages.find(item => item.id === page)!;

  return <div className="app-shell">
    <a href="#workspace" className="skip-link">跳到主要內容</a>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Terminal size={21} strokeWidth={2.3} /></span><span>Bridgit<small>YOUR CONNECTION WORKSPACE</small></span></div>
      <div className="nav-caption">工作區 <span>WORKSPACE</span></div>
      <nav aria-label="主要功能" className="side-nav">
        {pages.map(item => <Button key={item.id} variant="ghost" className="nav-item" aria-label={item.label} data-active={page === item.id} aria-current={page === item.id ? "page" : undefined} onPress={() => setPage(item.id)}>
          <item.icon size={19} /><span>{item.label}<small>{item.english}</small></span><ChevronRight className="nav-arrow" size={14} />
        </Button>)}
      </nav>
      <div className="sidebar-footer"><div className="local-note"><HardDrive size={17} /><span>本機工作區<small>設定由你掌控</small></span><span className="status-dot" /></div>
        <div className="sidebar-version"><span>Bridgit <span className="mono">v0.1.1</span></span><ArrowUpRight size={13} /></div>
      </div>
    </aside>
    <div className="workspace-shell">
      <header className="topbar"><div className="breadcrumb"><span>工作區</span><ChevronRight size={13} /><strong>{current.label}</strong></div>
        <div className="topbar-actions"><Chip size="sm" variant="soft"><HardDrive size={12} /> 本機</Chip>
          <Button variant="ghost" isIconOnly size="sm" aria-label={dark ? "切換淺色模式" : "切換深色模式"} onPress={() => setDark(!dark)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</Button>
        </div>
      </header>
      <main id="workspace" className="workspace" tabIndex={-1}>
        <div hidden={page !== "forward"}><Forward revision={revision} active={page === "forward"} /></div>
        <div hidden={page !== "config"}><SshConfig onChanged={() => setRevision(v => v + 1)} /></div>
        <div hidden={page !== "known"}><KnownHosts /></div>
        <footer className="workspace-footer"><span><ShieldCheck size={13} /> SSH 連線 · 本機設定管理</span><span>一個簡單、有序的工作區</span></footer>
      </main>
    </div>
  </div>;
}
