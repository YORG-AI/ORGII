// @vitest-environment jsdom
/**
 * Session-list status contract for `useNativeSessionStatusMonitor`.
 *
 * The `session-status-changed` Tauri event carries a raw, unvalidated wire
 * string and this hook writes it straight into `Session.status` for EVERY
 * session, foreground or background — the field that drives sidebar grouping,
 * Kanban lanes and every terminal-status predicate. Unlike the other
 * session-status writers there is no terminal guard in front of it, so this is
 * the widest of the four doors and the narrowing has to happen here.
 *
 * `expectRowStatus` takes a `SessionStatus`, so every expectation below is
 * compiler-proved to be inside the union *and* runtime-proved to be what the
 * row holds.
 */
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { resetTurnLifecycleForTests } from "@src/engines/SessionCore/control/turnLifecycle";
import {
  deliverSessionTerminalNotification,
  shouldDeliverSessionTerminalNotification,
} from "@src/hooks/session/sessionTerminalNotifications";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { SessionStatus } from "@src/types/session/session";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { useNativeSessionStatusMonitor } from "../useNativeSessionStatusMonitor";

const SESSION_ID = "cliagent-native-monitor";

type TauriHandler = (event: { payload: unknown }) => void;

const listeners = vi.hoisted(() => ({
  handlers: new Map<string, TauriHandler>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: TauriHandler) => {
    listeners.handlers.set(name, handler);
    return listeners.unlisten;
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Settings are backed by the on-disk settings file in production; the hook only
// forwards them to the notification delivery it also does not own.
vi.mock("@src/store/ui/notificationAtom", async () => {
  const { atom } = await import("jotai");
  return { notificationSettingsAtom: atom({}) };
});

vi.mock("@src/hooks/session/sessionTerminalNotifications", () => ({
  deliverSessionTerminalNotification: vi.fn(),
  shouldDeliverSessionTerminalNotification: vi.fn(() => false),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

/** Hook options for the next `Probe` mount; reset to the main-window
 *  default (deliver notifications) before each test. */
let probeOptions: Parameters<typeof useNativeSessionStatusMonitor>[0];

function Probe(): null {
  useNativeSessionStatusMonitor(probeOptions);
  return null;
}

function seedSessionRow(): void {
  getInstrumentedStore().set(sessionsAtom, [
    {
      session_id: SESSION_ID,
      status: "running",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  ]);
}

function expectRowStatus(expected: SessionStatus): void {
  expect(
    getInstrumentedStore()
      .get(sessionsAtom)
      .map((session) => session.status)
  ).toEqual([expected]);
}

/** Deliver one `session-status-changed` payload the way the backend would. */
function emitStatus(status: string): void {
  const handler = listeners.handlers.get("session-status-changed");
  expect(handler).toBeDefined();
  act(() => {
    handler?.({ payload: { sessionId: SESSION_ID, status } });
  });
}

describe("useNativeSessionStatusMonitor session-list status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listeners.handlers.clear();
    probeOptions = undefined;
    resetTurnLifecycleForTests();
    createInstrumentedStore();
    seedSessionRow();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(Probe));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("narrows an unknown wire status before it reaches the session list cache", () => {
    emitStatus("quantum_superposition");

    expectRowStatus("idle");
  });

  it("maps the CLI-only 'installing' status onto the running lane", () => {
    // `installing` is emitted by the Rust session enum but has no
    // `SessionStatus` counterpart. `RUNNING_SESSION_STATUSES`
    // (features/TaskKanban/config.ts) and `IN_PROGRESS_STATUSES`
    // (util/session/sessionInProgress.ts) both group it with `running`, so the
    // row keeps its lane and its spinner instead of holding an out-of-union
    // value.
    emitStatus("installing");

    expectRowStatus("running");
  });

  it("passes a terminal status through to the session list", () => {
    // The narrowing must not flatten every value to the fallback — a terminal
    // still has to land verbatim or background sessions never leave the board's
    // in-progress lane.
    emitStatus("completed");

    expectRowStatus("completed");
  });

  it("passes a non-terminal active status through to the session list", () => {
    emitStatus("waiting_for_user");

    expectRowStatus("waiting_for_user");
  });

  it("notifications:false skips delivery but still applies status and rename", async () => {
    // Prove the boundary would deliver: under the default (main-window)
    // mount this exact predicate triggers a native notification…
    vi.mocked(shouldDeliverSessionTerminalNotification).mockReturnValueOnce(
      true
    );
    emitStatus("failed");
    expect(deliverSessionTerminalNotification).toHaveBeenCalledTimes(1);

    // …then remount notification-free, the way the detached session window
    // (`SessionWindowBridges`) mounts this hook.
    act(() => {
      root.unmount();
    });
    listeners.handlers.clear();
    vi.mocked(deliverSessionTerminalNotification).mockClear();
    probeOptions = { notifications: false };
    root = createRoot(container);
    act(() => {
      root.render(createElement(Probe));
    });

    // "failed" → "completed" is a completed boundary, so the default mount
    // would have delivered here too — the option is what suppresses it.
    emitStatus("completed");
    const renameHandler = listeners.handlers.get("session-renamed");
    expect(renameHandler).toBeDefined();
    await act(async () => {
      renameHandler?.({ payload: { sessionId: SESSION_ID, name: "Renamed" } });
      // The rename handler resolves dynamic imports before writing; a
      // macrotask lets those microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deliverSessionTerminalNotification).not.toHaveBeenCalled();
    expectRowStatus("completed");
    expect(
      getInstrumentedStore()
        .get(sessionsAtom)
        .map((session) => session.name)
    ).toEqual(["Renamed"]);
  });
});
