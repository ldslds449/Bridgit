import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from '@tauri-apps/api/event';
import { Chart as ChartJS, LineController, LineElement, PointElement, LinearScale, Title, CategoryScale, Legend } from 'chart.js';
import { Line } from 'react-chartjs-2';
import Input from "../component/Input";
import Toast from "../component/Toast";
import Button from "../component/Button";
import "./Forward.css";

ChartJS.register(LineController, LineElement, PointElement, LinearScale, Title, CategoryScale, Legend);

enum ConnectStatus {
  Disconnected = 1,
  Connected,
  Connecting,
}

type TransferUpdatePayload = {
  send_bytes: number;
  recv_bytes: number;
}

function Forward() {
  const ChartDataMaxSize = 50;

  const [localIP, setLocalIP] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState(5678);
  const [ip, setIP] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const [connectStatus, setconnectStatus] = useState(ConnectStatus.Disconnected);
  const [errorMsg, setErrorMsg] = useState("");

  const [numberOfConnect, setNumberOfConnect] = useState(0);
  const [chartData, setChartData] = useState({
    labels: new Array(ChartDataMaxSize).fill(""),
    datasets: [{
      label: 'Send',
      data: [] as number[],
      borderColor: 'rgb(53, 162, 235)',
      backgroundColor: 'rgba(53, 162, 235, 0.5)',
      tension: 0.1
    },
    {
      label: 'Recv',
      data: [] as number[],
      borderColor: 'rgb(255, 99, 132)',
      backgroundColor: 'rgba(255, 99, 132, 0.5)',
      tension: 0.1
    }]
  });

  async function invokeForward() {
    console.log(`Start to connect ${user}@${ip}:${port}`);
    setconnectStatus(ConnectStatus.Connecting);

    invoke("forward", {
      localIp: localIP,
      localPort: localPort,
      remoteIp: ip,
      remotePort: port,
      user: user,
      password: password
    }).then(() => {
      setconnectStatus(ConnectStatus.Connected);
    }).catch((error) => {
      setconnectStatus(ConnectStatus.Disconnected);
      setErrorMsg(error);
      setTimeout(() => setErrorMsg(""), 3000);
    });
  }

  async function invokeStop() {
    invoke("stop").then(() => {
      setconnectStatus(ConnectStatus.Disconnected);
    });
  }

  useEffect(() => {
    const unlisten = listen<number>("connect-count-change", (event) => {
      console.log(`${event.payload} Connect`);
      setNumberOfConnect(event.payload);
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<TransferUpdatePayload>("update-transfer-statistic", (event) => {
      setChartData((prevData) => {
        const prevSendDataset = prevData.datasets[0];
        const prevRecvDataset = prevData.datasets[1];
        const prevSendData = prevSendDataset.data;
        const prevRecvData = prevRecvDataset.data;
        const newData = {
          ...prevData,
          datasets: [
            {
              ...prevSendDataset,
              data: [...prevSendData.slice(Math.max(prevSendData.length - ChartDataMaxSize + 1, 0), prevSendData.length), event.payload.send_bytes],
            },
            {
              ...prevRecvDataset,
              data: [...prevRecvData.slice(Math.max(prevRecvData.length - ChartDataMaxSize + 1, 0), prevRecvData.length), event.payload.recv_bytes],
            },
          ],
        };
        return newData;
      });
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  const buttonStr = connectStatus == ConnectStatus.Connecting ? "Connecting" : (connectStatus == ConnectStatus.Disconnected ? "Connect" : "Stop");

  return (
    <main className="container">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();

          const ipv4Regex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
          const portRegex = /^(6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[0-9]{1,4})$/;
          if (!ipv4Regex.test(localIP)) {
            setErrorMsg("Invalid 'Local IP'");
            return;
          }
          if (!portRegex.test(localPort.toString())) {
            setErrorMsg("Invalid 'Local Port'");
            return;
          }
          if (!ipv4Regex.test(ip)) {
            setErrorMsg("Invalid 'Remote IP'");
            return;
          }
          if (!portRegex.test(port.toString())) {
            setErrorMsg("Invalid 'Remote Port'");
            return;
          }
          if (user.length == 0) {
            setErrorMsg("Please input 'User'");
            return;
          }
          if (password.length == 0) {
            setErrorMsg("Please input 'Password'");
            return;
          }

          if (connectStatus == ConnectStatus.Disconnected) {
            invokeForward();
          } else {
            invokeStop();
          }
        }}
      >
        <div style={{ display: "block" }}>
          <Input value={localIP} label="Local IP" placeholder="ip" onChange={setLocalIP} type="text"></Input>
          <Input value={localPort.toString()} label="Local Port" placeholder="5678" onChange={(v) => { setLocalPort(parseInt(v)) }} type="text"></Input>
          <Input value={ip} label="Remote IP" placeholder="ip" onChange={setIP} type="text"></Input>
          <Input value={port.toString()} label="Remote Port" placeholder="22" onChange={(v) => { setPort(parseInt(v)) }} type="text"></Input>
          <Input value={user} label="User" placeholder="root" onChange={setUser} type="text"></Input>
          <Input value={password} label="Password" placeholder="password" onChange={setPassword} type="password"></Input>
        </div>
        <Button text={buttonStr} disable={connectStatus == ConnectStatus.Connecting} danger={connectStatus == ConnectStatus.Connected} />
      </form>
      <Toast hidden={errorMsg.length == 0} message={errorMsg}></Toast>
      <div style={{ padding: "10px" }}>Connect Count: {connectStatus == ConnectStatus.Connected ? numberOfConnect : "---"}</div>
      {true && <Line data={chartData} options={{
        animation: false,
        scales: {
          y: {
            title: {
              display: true,
              text: "Bytes"
            }
          }
        },
        responsive: true,
        plugins: {
          legend: {
            position: 'top' as const,
          },
        },
      }} />}
    </main>
  );
}

export default Forward;
