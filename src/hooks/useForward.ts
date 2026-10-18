import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export enum ConnectStatus {
  Disconnected = 1,
  Connected,
  Connecting,
  Stopping,
}

type TransferUpdatePayload = { send_bytes: number; recv_bytes: number };
type HostKey = { host: string; port: number; key: string; fingerprint: string };
type ConnectError = { message: string; host_key?: HostKey | null };
type ForwardOptions = {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  user: string;
  password: string;
  alias?: string | null;
  identityFile?: string | null;
  passphrase?: string;
  targetHost?: string;
  targetPort?: number;
};

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return String(error);
}

export function useForward() {
  const ChartDataMaxSize = 50;
  const [connectStatus, setConnectStatus] = useState(ConnectStatus.Disconnected);
  const [errorMsg, setErrorMsg] = useState("");
  const [numberOfConnect, setNumberOfConnect] = useState(0);
  const [pendingHost, setPendingHost] = useState<{ key: HostKey; options: ForwardOptions } | null>(
    null,
  );
  const busy = useRef(false);
  const stopVersion = useRef(0);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listenersReady = useRef<Promise<void>>(Promise.resolve());
  const [chartData, setChartData] = useState({
    labels: new Array(ChartDataMaxSize).fill(""),
    datasets: [
      {
        label: "Send",
        data: [] as number[],
        borderColor: "rgb(53, 162, 235)",
        backgroundColor: "rgba(53, 162, 235, 0.5)",
        tension: 0.1,
      },
      {
        label: "Recv",
        data: [] as number[],
        borderColor: "rgb(255, 99, 132)",
        backgroundColor: "rgba(255, 99, 132, 0.5)",
        tension: 0.1,
      },
    ],
  });

  const showErrorMsg = useCallback((error: unknown) => {
    clearTimeout(errorTimer.current);
    setErrorMsg(errorMessage(error));
    errorTimer.current = setTimeout(() => setErrorMsg(""), 5000);
  }, []);

  async function start(options: ForwardOptions, trustedKey?: string) {
    setConnectStatus(ConnectStatus.Connecting);
    try {
      await listenersReady.current;
      const version = stopVersion.current;
      await invoke("forward", { ...options, trustedKey });
      if (version === stopVersion.current) setConnectStatus(ConnectStatus.Connected);
      busy.current = false;
    } catch (error) {
      const challenge =
        typeof error === "object" && error !== null ? (error as ConnectError).host_key : null;
      if (challenge) {
        setPendingHost({ key: challenge, options });
        busy.current = false;
      } else {
        setConnectStatus(ConnectStatus.Disconnected);
        busy.current = false;
        showErrorMsg(error);
      }
    }
  }

  async function invokeForward(options: ForwardOptions) {
    if (busy.current || pendingHost) return;
    busy.current = true;
    await start({ ...options });
  }

  async function trustHost() {
    if (!pendingHost || busy.current) return;
    busy.current = true;
    const { options, key } = pendingHost;
    setPendingHost(null);
    await start(options, key.key);
  }

  function rejectHost() {
    setPendingHost(null);
    setConnectStatus(ConnectStatus.Disconnected);
    busy.current = false;
  }

  async function invokeStop() {
    if (busy.current) return;
    busy.current = true;
    setConnectStatus(ConnectStatus.Stopping);
    try {
      await invoke("stop");
      setConnectStatus(ConnectStatus.Disconnected);
      setNumberOfConnect(0);
    } catch (error) {
      // The backend releases its state even when closing the SSH transport fails.
      setConnectStatus(ConnectStatus.Disconnected);
      showErrorMsg(error);
    } finally {
      setNumberOfConnect(0);
      busy.current = false;
    }
  }

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    function subscribe<T>(name: string, callback: (payload: T) => void) {
      return listen<T>(name, (event) => {
        if (!disposed) callback(event.payload);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }
    const ready = Promise.all([
      subscribe<number>("connect-count-change", setNumberOfConnect),
      subscribe<string>("tunnel-error", showErrorMsg),
      subscribe<null>("forward-stopped", () => {
        stopVersion.current += 1;
        setConnectStatus(ConnectStatus.Disconnected);
        setNumberOfConnect(0);
      }),
      subscribe<TransferUpdatePayload>("update-transfer-statistic", (payload) => {
        setChartData((previous) => ({
          ...previous,
          datasets: previous.datasets.map((dataset, index) => ({
            ...dataset,
            data: [
              ...dataset.data.slice(-(ChartDataMaxSize - 1)),
              index === 0 ? payload.send_bytes : payload.recv_bytes,
            ],
          })),
        }));
      }),
    ]).then(() => {});
    listenersReady.current = ready;
    void ready.catch(showErrorMsg);
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      clearTimeout(errorTimer.current);
    };
  }, [showErrorMsg]);

  return {
    connectStatus,
    errorMsg,
    numberOfConnect,
    chartData,
    showErrorMsg,
    invokeForward,
    invokeStop,
    hostKey: pendingHost?.key,
    trustHost,
    rejectHost,
  };
}
