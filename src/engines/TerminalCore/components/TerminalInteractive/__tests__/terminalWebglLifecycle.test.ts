import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUSPEND_DELAY_MS = 10_000;

const addonInstances: FakeWebglAddon[] = [];
let webglAllowed = true;

class FakeWebglAddon {
  disposed = false;
  contextLossHandler: (() => void) | null = null;

  constructor() {
    addonInstances.push(this);
  }

  onContextLoss(handler: () => void): void {
    this.contextLossHandler = handler;
  }

  dispose(): void {
    this.disposed = true;
  }
}

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn(() => new FakeWebglAddon()),
}));

vi.mock("../terminalRendererPolicy", () => ({
  shouldLoadTerminalWebgl: () => webglAllowed,
}));

const { createTerminalWebglController } =
  await import("../terminalWebglLifecycle");
const { _getActiveContextCount, _resetForTests, acquireWebglSlot } =
  await import("../webglContextManager");

const MAX_WEBGL_CONTEXTS = 8;

function createHarness(options: { attached?: boolean } = {}) {
  const terminal = {
    // The controller only tests this for presence — a terminal with no element
    // has no drawing surface to bind. The suite runs without a DOM, so a
    // stand-in object says the same thing as a real one.
    element: options.attached === false ? undefined : {},
    loadAddon: vi.fn(),
  } as unknown as Terminal;

  const webglAddonRef = { current: null as WebglAddon | null };
  const controller = createTerminalWebglController(terminal, webglAddonRef);
  return { controller, terminal, webglAddonRef };
}

beforeEach(() => {
  vi.useFakeTimers();
  addonInstances.length = 0;
  webglAllowed = true;
  _resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  _resetForTests();
});

describe("terminal webgl lifecycle", () => {
  it("attaches the renderer and claims a context slot", () => {
    const { controller, webglAddonRef } = createHarness();

    controller.attach();

    expect(webglAddonRef.current).not.toBeNull();
    expect(_getActiveContextCount()).toBe(1);
  });

  it("attaches at most one renderer per pane", () => {
    const { controller } = createHarness();

    controller.attach();
    controller.attach();

    expect(_getActiveContextCount()).toBe(1);
  });

  it("skips platforms where WebGL is not used", () => {
    webglAllowed = false;
    const { controller, webglAddonRef } = createHarness();

    controller.attach();

    expect(webglAddonRef.current).toBeNull();
    expect(_getActiveContextCount()).toBe(0);
  });

  it("skips a terminal that is not in the DOM", () => {
    const { controller, webglAddonRef } = createHarness({ attached: false });

    controller.attach();

    expect(webglAddonRef.current).toBeNull();
  });

  it("keeps the context through a brief hide", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();

    controller.setForeground(false);
    vi.advanceTimersByTime(SUSPEND_DELAY_MS - 1);
    controller.setForeground(true);
    vi.advanceTimersByTime(SUSPEND_DELAY_MS);

    // Flipping between two tabs must not pay for a context re-creation.
    expect(webglAddonRef.current).not.toBeNull();
    expect(_getActiveContextCount()).toBe(1);
  });

  it("gives the context back once a pane stays hidden", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();

    controller.setForeground(false);
    vi.advanceTimersByTime(SUSPEND_DELAY_MS);

    expect(webglAddonRef.current).toBeNull();
    expect(addonInstances[0]?.disposed).toBe(true);
    expect(_getActiveContextCount()).toBe(0);
  });

  it("re-attaches when a suspended pane is revealed", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();
    controller.setForeground(false);
    vi.advanceTimersByTime(SUSPEND_DELAY_MS);

    controller.setForeground(true);

    expect(webglAddonRef.current).not.toBeNull();
    expect(_getActiveContextCount()).toBe(1);
  });

  it("takes a freed slot without being re-attached by the caller", () => {
    const holder = createHarness();
    for (let i = 0; i < MAX_WEBGL_CONTEXTS - 1; i++) acquireWebglSlot();
    holder.controller.attach();
    expect(holder.webglAddonRef.current).not.toBeNull();

    const waiting = createHarness();
    waiting.controller.attach();
    expect(waiting.webglAddonRef.current).toBeNull();

    holder.controller.dispose();

    expect(waiting.webglAddonRef.current).not.toBeNull();
  });

  it("falls back to the DOM renderer after a context loss", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();

    addonInstances[0]?.contextLossHandler?.();

    expect(webglAddonRef.current).toBeNull();
    expect(_getActiveContextCount()).toBe(0);
  });

  it("does not retry a lost context while the pane stays visible", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();
    addonInstances[0]?.contextLossHandler?.();

    controller.attach();

    // Retrying against a driver that is still resetting only churns.
    expect(webglAddonRef.current).toBeNull();
  });

  it("retries a lost context on the next reveal", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();
    addonInstances[0]?.contextLossHandler?.();

    controller.setForeground(false);
    controller.setForeground(true);

    expect(webglAddonRef.current).not.toBeNull();
  });

  it("releases the slot when activation throws after the context exists", () => {
    const { controller, webglAddonRef, terminal } = createHarness();
    vi.mocked(terminal.loadAddon).mockImplementation(() => {
      throw new Error("activate failed");
    });

    controller.attach();

    expect(webglAddonRef.current).toBeNull();
    expect(addonInstances[0]?.disposed).toBe(true);
    expect(_getActiveContextCount()).toBe(0);
  });

  it("releases everything on dispose", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();

    controller.dispose();

    expect(webglAddonRef.current).toBeNull();
    expect(_getActiveContextCount()).toBe(0);
  });

  it("ignores visibility changes after dispose", () => {
    const { controller, webglAddonRef } = createHarness();
    controller.attach();
    controller.dispose();

    controller.setForeground(false);
    controller.setForeground(true);

    expect(webglAddonRef.current).toBeNull();
    expect(_getActiveContextCount()).toBe(0);
  });
});
