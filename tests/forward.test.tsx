import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";

// A synchronous hook harness keeps these IPC/state tests independent of a browser.
const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  mounted: false,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
}));
vi.mock("react", () => ({
  useState(initial: any) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [
      hooks.slots[index],
      (value: any) => {
        hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useRef(initial: any) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback: (callback: any) => callback,
  useEffect: (effect: () => void) => {
    if (!hooks.mounted) hooks.effects.push(effect);
  },
}));
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: any) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }));
vi.mock("../src/component/Button", () => ({ default: () => null }));
vi.mock("../src/component/Input", () => ({ default: () => null }));
vi.mock("../src/component/Toast", () => ({ default: () => null }));
vi.mock("../src/ui/TransferChart", () => ({ default: () => null }));

import { ConnectStatus, useForward } from "../src/hooks/useForward";
import Forward from "../src/ui/Forward";

function render<T>(component: () => T): T {
  hooks.cursor = 0;
  const result = component();
  if (!hooks.mounted) {
    hooks.mounted = true;
    hooks.effects.forEach((effect) => {
      const cleanup = effect();
      if (cleanup) hooks.cleanups.push(cleanup);
    });
  }
  return result;
}
const options = {
  localIp: "127.0.0.1",
  localPort: 5678,
  remoteIp: "127.0.0.1",
  remotePort: 22,
  user: "user",
  password: "secret",
};

beforeEach(() => {
  vi.useFakeTimers();
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.mounted = false;
  hooks.effects = [];
  hooks.cleanups = [];
  ipc.handlers.clear();
  ipc.invoke.mockReset().mockResolvedValue(undefined);
  ipc.listen.mockReset().mockImplementation(async (name, handler) => {
    ipc.handlers.set(name, handler);
    return () => ipc.handlers.delete(name);
  });
});
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

test("Stop works after connected form fields are cleared", async () => {
  render(Forward);
  hooks.slots[5] = ""; // password field
  hooks.slots[6] = ConnectStatus.Connected;
  const page = render(Forward);
  const form = (page.props as any).children[0];
  form.props.onSubmit({ preventDefault() {} });
  await Promise.resolve();
  expect(ipc.invoke).toHaveBeenCalledWith("stop");
});

test("stop failures are shown and allow a retry", async () => {
  let state = render(useForward);
  ipc.invoke.mockRejectedValueOnce("Close failed");
  await state.invokeStop();
  state = render(useForward);
  expect(state.errorMsg).toBe("Close failed");
  expect(state.connectStatus).toBe(ConnectStatus.Disconnected);
  await state.invokeForward(options);
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Connected);
});

test("host approval retries only the exact challenged key and original options", async () => {
  const key = {
    host: options.remoteIp,
    port: 22,
    fingerprint: "SHA256:test",
    key: "ssh-ed25519 test",
  };
  ipc.invoke.mockRejectedValueOnce({ message: "Unknown host", host_key: key });
  let state = render(useForward);
  await state.invokeForward(options);
  state = render(useForward);
  expect(state.hostKey).toEqual(key);
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  await state.trustHost();
  expect(ipc.invoke).toHaveBeenLastCalledWith("forward", { ...options, trustedKey: key.key });
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Connected);
});

test("declining a host never sends a trust retry", async () => {
  ipc.invoke.mockRejectedValueOnce({ message: "Unknown host", host_key: { key: "test" } });
  await render(useForward).invokeForward(options);
  render(useForward).rejectHost();
  expect(render(useForward).hostKey).toBeUndefined();
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Disconnected);
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
});

test("tunnel errors retain the connection; SSH shutdown resets it", async () => {
  await render(useForward).invokeForward(options);
  ipc.handlers.get("tunnel-error")!({ payload: "Channel refused" });
  expect(render(useForward).errorMsg).toBe("Channel refused");
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Connected);
  ipc.handlers.get("forward-stopped")!({ payload: null });
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Disconnected);
});

test("double submissions create only one forward request", async () => {
  const state = render(useForward);
  await Promise.all([state.invokeForward(options), state.invokeForward(options)]);
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
});

test("a new error gets its full display time", () => {
  const state = render(useForward);
  state.showErrorMsg("First");
  vi.advanceTimersByTime(4000);
  state.showErrorMsg("Second");
  vi.advanceTimersByTime(1000);
  expect(render(useForward).errorMsg).toBe("Second");
  vi.advanceTimersByTime(4000);
  expect(render(useForward).errorMsg).toBe("");
});

test("double host approvals create only one trust retry", async () => {
  ipc.invoke.mockRejectedValueOnce({ message: "Unknown host", host_key: { key: "test" } });
  await render(useForward).invokeForward(options);
  const state = render(useForward);
  await Promise.all([state.trustHost(), state.trustHost()]);
  expect(ipc.invoke).toHaveBeenCalledTimes(2);
});

test("an immediate SSH disconnect is not overwritten by the start response", async () => {
  ipc.invoke.mockImplementationOnce(async () => {
    ipc.handlers.get("forward-stopped")!({ payload: null });
  });
  await render(useForward).invokeForward(options);
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Disconnected);
});
