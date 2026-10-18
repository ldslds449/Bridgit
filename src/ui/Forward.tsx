import { useState, useEffect, useRef } from "react";
import { ConnectStatus, useForward } from "../hooks/useForward";
import TransferChart from "./TransferChart";
import Input from "../component/Input";
import Toast from "../component/Toast";
import Button from "../component/Button";
import "./Forward.css";

function Forward() {
  const [localIP, setLocalIP] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState(5678);
  const [ip, setIP] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const {
    connectStatus,
    errorMsg,
    numberOfConnect,
    chartData,
    showErrorMsg,
    invokeForward,
    invokeStop,
    hostKey,
    trustHost,
    rejectHost,
  } = useForward();
  const hostDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (hostKey) hostDialog.current?.showModal();
  }, [hostKey]);

  const buttonStr =
    connectStatus === ConnectStatus.Connecting
      ? "Connecting"
      : connectStatus === ConnectStatus.Stopping
        ? "Stopping"
        : connectStatus === ConnectStatus.Disconnected
          ? "Connect"
          : "Stop";

  return (
    <main className="container">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();

          if (connectStatus === ConnectStatus.Connected) {
            void invokeStop();
            return;
          }
          if (connectStatus !== ConnectStatus.Disconnected) return;

          const ipv4Regex =
            /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
          const portRegex =
            /^(6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[0-9]{1,4})$/;
          if (!ipv4Regex.test(localIP)) {
            showErrorMsg("Invalid 'Local IP'");
            return;
          }
          if (!portRegex.test(localPort.toString())) {
            showErrorMsg("Invalid 'Local Port'");
            return;
          }
          if (!ipv4Regex.test(ip)) {
            showErrorMsg("Invalid 'Remote IP'");
            return;
          }
          if (!portRegex.test(port.toString())) {
            showErrorMsg("Invalid 'Remote Port'");
            return;
          }
          if (user.length == 0) {
            showErrorMsg("Please input 'User'");
            return;
          }
          if (password.length == 0) {
            showErrorMsg("Please input 'Password'");
            return;
          }

          void invokeForward({
            localIp: localIP,
            localPort,
            remoteIp: ip,
            remotePort: port,
            user,
            password,
          });
        }}
      >
        <div style={{ display: "block" }}>
          <Input
            value={localIP}
            label="Local IP"
            placeholder="ip"
            onChange={setLocalIP}
            type="text"
          ></Input>
          <Input
            value={localPort.toString()}
            label="Local Port"
            placeholder="5678"
            onChange={(v) => {
              const n = parseInt(v);
              if (!isNaN(n)) setLocalPort(n);
            }}
            type="text"
          ></Input>
          <Input value={ip} label="Remote IP" placeholder="ip" onChange={setIP} type="text"></Input>
          <Input
            value={port.toString()}
            label="Remote Port"
            placeholder="22"
            onChange={(v) => {
              const n = parseInt(v);
              if (!isNaN(n)) setPort(n);
            }}
            type="text"
          ></Input>
          <Input
            value={user}
            label="User"
            placeholder="root"
            onChange={setUser}
            type="text"
          ></Input>
          <Input
            value={password}
            label="Password"
            placeholder="password"
            onChange={setPassword}
            type="password"
          ></Input>
        </div>
        <Button
          text={buttonStr}
          disable={
            connectStatus === ConnectStatus.Connecting || connectStatus === ConnectStatus.Stopping
          }
          danger={connectStatus == ConnectStatus.Connected}
        />
      </form>
      {hostKey && (
        <dialog
          ref={hostDialog}
          aria-labelledby="host-key-title"
          onCancel={(event) => {
            event.preventDefault();
            rejectHost();
          }}
        >
          <h2 id="host-key-title">Trust SSH host?</h2>
          <p>
            {hostKey.host}:{hostKey.port}
          </p>
          <p>
            SHA-256 fingerprint: <code>{hostKey.fingerprint}</code>
          </p>
          <p>Verify this fingerprint with the server administrator before trusting it.</p>
          <Button text="Cancel" onClick={rejectHost} />
          <Button
            text="Trust and connect"
            onClick={() => {
              void trustHost();
            }}
          />
        </dialog>
      )}
      <Toast hidden={errorMsg.length == 0} message={errorMsg}></Toast>
      <div style={{ padding: "10px" }}>
        Connect Count: {connectStatus == ConnectStatus.Connected ? numberOfConnect : "---"}
      </div>
      <TransferChart data={chartData} />
    </main>
  );
}

export default Forward;
