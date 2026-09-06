// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRamMonitorMetrics } from "./useRamMonitorMetrics";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refresh: vi.fn(),
  collect: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));
vi.mock("@src/hooks/perf", () => ({
  useRuntimeRamStats: () => ({ refresh: mocks.refresh, rows: [] }),
  useAppMemorySnapshot: () => ({}),
  collectWebViewRuntimeDiagnostics: mocks.collect,
  getLoadedScriptSourceStats: () => ({}),
}));
vi.mock("@src/util/memory/cacheRegistry", () => ({
  listRegisteredCaches: () => [],
}));
vi.mock(
  "@src/engines/TerminalCore/components/TerminalInteractive/bufferCache",
  () => ({
    getTerminalBufferCacheStats: () => ({ bytes: 0, entries: 0 }),
  })
);

let root: Root;
let host: HTMLDivElement;
let visible = true;
function Probe({ open }: { open: boolean }) {
  useRamMonitorMetrics(open);
  return null;
}
async function render(open = true) {
  await act(async () => root.render(createElement(Probe, { open })));
}
async function visibility(next: boolean) {
  await act(async () => {
    visible = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const calls = (command: string) =>
  mocks.invoke.mock.calls.filter(([name]) => name === command).length;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  visible = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  mocks.invoke.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sidebar RAM polling lifecycle", () => {
  it("stops all work while hidden and refreshes once on return", async () => {
    await render();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await visibility(false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(120_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await visibility(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(calls("get_pty_memory_usage")).toBe(2);
    await render(false);
    expect(vi.getTimerCount()).toBe(0);
    await visibility(false);
    await visibility(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
  it("does no work on hidden mount and avoids duplicate minute-boundary refreshes", async () => {
    visible = false;
    await render();
    expect(mocks.invoke).not.toHaveBeenCalled();
    await visibility(true);
    await advance(60_000);
    expect(calls("get_memory_breakdown")).toBe(5);
    expect(calls("get_pty_memory_usage")).toBe(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(5);
  });
  it("discards stale completions and coalesces a visibility return while IPC is pending", async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation((name) =>
      name === "get_memory_breakdown"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve([])
    );
    await render();
    await visibility(false);
    await visibility(true);
    expect(calls("get_memory_breakdown")).toBe(1);
    await act(async () => resolve([]));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(calls("get_memory_breakdown")).toBe(2);
    await render(false);
    await act(async () => resolve([]));
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
