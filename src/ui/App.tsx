import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Input from "../component/Input";
import "./App.css";

function App() {
  const [ip, setIP] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [output, setOutput] = useState("");
  const [commandStr, setCommandStr] = useState("ps aux");

  async function command() {
    console.log(`Command ${commandStr}`);
    setOutput(output + "\n" + await invoke("command", { commandStr }));
  }

  async function greet() {
    console.log("Start to connect");
    setOutput(await invoke("connect", { ip, port, user, password }));
  }

  return (
    <main className="container">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <div style={{ display: "block" }}>
          <Input value={ip} label="IP" placeholder="ip" onChange={setIP} type="text"></Input>
          <Input value={port.toString()} label="Port" placeholder="22" onChange={(v) => { setPort(parseInt(v)) }} type="text"></Input>
          <Input value={user} label="User" placeholder="root" onChange={setUser} type="text"></Input>
          <Input value={password} label="Password" placeholder="password" onChange={setPassword} type="password"></Input>
        </div>
        <button type="submit">Connect</button>
      </form>
      <pre style={{ textAlign: "left", height: "350px", overflow: "auto" }}>{output}</pre>

      <form onSubmit={(e) => {
        e.preventDefault();
        command();
      }}>
        <input
          id="command-input"
          onChange={(e) => setCommandStr(e.currentTarget.value)}
          placeholder="Command"
          value={commandStr}
        />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

export default App;
