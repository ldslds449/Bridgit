import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";

// A synchronous hook harness keeps these IPC/state tests independent of a browser.
const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  mounted: false,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
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
import { useConfirmation } from "../src/component/useConfirmation";

function findElement(node: any, predicate: (element: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
}

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
  const form = findElement(page, element => element.type === "form");
  form.props.onSubmit({ preventDefault() {} });
  await Promise.resolve();
  expect(ipc.invoke).toHaveBeenCalledWith("stop");
});

test("the redesigned form sends separate SSH and forwarding endpoints", async () => {
  const page = render(Forward);
  for (const [label, value] of [["主機名稱 / IP", "gateway.example.com"], ["使用者名稱", "alice"], ["登入密碼", "secret"], ["目的主機", "database.internal"], ["目的 Port", "5432"]]) {
    findElement(page, element => element.props?.label === label).props.onChange(value);
  }
  findElement(render(Forward), element => element.type === "form").props.onSubmit({ preventDefault() {} });
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("forward", expect.objectContaining({
    remoteIp: "gateway.example.com", remotePort: 22, user: "alice", password: "secret",
    targetHost: "database.internal", targetPort: 5432, localPort: 5678,
  })));
});

test("an empty local port blocks submission instead of reusing the old value", () => {
  const page = render(Forward);
  findElement(page, element => element.props?.label === "本機 Port").props.onChange("");
  findElement(render(Forward), element => element.type === "form").props.onSubmit({ preventDefault() {} });
  expect(ipc.invoke).not.toHaveBeenCalledWith("forward", expect.anything());
  expect(hooks.slots[7]).toBe("本機 Port 必須介於 1–65535");
});

test("the redesigned jump form validates and sends separate bastion credentials", async () => {
  let page = render(Forward);
  for (const [label, value] of [["主機名稱 / IP", "target.internal"], ["使用者名稱", "alice"], ["登入密碼", "target-secret"]]) {
    findElement(page, element => element.props?.label === label).props.onChange(value);
  }
  findElement(page, element => element.type === "input" && element.props.type === "checkbox").props.onChange({ target: { checked: true } });
  page = render(Forward);
  findElement(page, element => element.type === "form").props.onSubmit({ preventDefault() {} });
  expect(ipc.invoke).not.toHaveBeenCalledWith("forward", expect.anything());
  for (const [label, value] of [["跳板機主機", "bastion.example.com"], ["跳板機使用者", "jump-user"], ["跳板機密碼", "jump-secret"]]) {
    findElement(page, element => element.props?.label === label).props.onChange(value);
  }
  findElement(render(Forward), element => element.type === "form").props.onSubmit({ preventDefault() {} });
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("forward", expect.objectContaining({
    remoteIp: "target.internal", user: "alice", password: "target-secret",
    jump: { host: "bastion.example.com", port: 22, user: "jump-user", password: "jump-secret" },
  })));
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

test("jump and target host approvals stay separate across retries", async () => {
  const jump = { host: "bastion.example.com", port: 22, user: "jump-user", password: "jump-secret" };
  const jumpKey = { host: jump.host, port: 22, key: "jump-key", fingerprint: "SHA256:jump", is_jump: true };
  const targetKey = { host: options.remoteIp, port: 22, key: "target-key", fingerprint: "SHA256:target", is_jump: false };
  ipc.invoke.mockRejectedValueOnce({ host_key: jumpKey }).mockRejectedValueOnce({ host_key: targetKey });
  await render(useForward).invokeForward({ ...options, jump });
  expect(render(useForward).hostKey).toEqual(jumpKey);
  await render(useForward).trustHost();
  expect(ipc.invoke).toHaveBeenLastCalledWith("forward", { ...options, jump: { ...jump, trustedKey: jumpKey.key }, trustedKey: undefined });
  expect(render(useForward).hostKey).toEqual(targetKey);
  await render(useForward).trustHost();
  expect(ipc.invoke).toHaveBeenLastCalledWith("forward", { ...options, jump: { ...jump, trustedKey: jumpKey.key }, trustedKey: targetKey.key });
  expect(render(useForward).connectStatus).toBe(ConnectStatus.Connected);
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

test("confirmation cancellation never approves the operation", async () => {
  const state = render(useConfirmation);
  const answer = state.confirm({ title: "Reset host", description: "Remove trust" });
  const open = render(useConfirmation);
  expect(open.dialog.props.isOpen).toBe(true);
  open.dialog.props.onOpenChange(false);
  expect(await answer).toBe(false);
  expect(render(useConfirmation).dialog.props.isOpen).toBe(false);
});

test("clearing all trust requires the exact confirmation phrase", async () => {
  const state = render(useConfirmation);
  const answer = state.confirm({ title: "Clear trust", description: "Remove all", phrase: "RESET", confirmLabel: "Clear" });
  let dialog = render(useConfirmation).dialog;
  expect(findElement(dialog, element => element.props?.text === "Clear").props.disable).toBe(true);
  findElement(dialog, element => element.props?.label === "輸入 RESET 確認").props.onChange("RESET");
  dialog = render(useConfirmation).dialog;
  const confirm = findElement(dialog, element => element.props?.text === "Clear");
  expect(confirm.props.disable).toBe(false);
  confirm.props.onClick();
  expect(await answer).toBe(true);
});
