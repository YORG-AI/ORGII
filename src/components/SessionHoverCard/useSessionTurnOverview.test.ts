// @vitest-environment jsdom
/**
 * A session with no turn index rejects inside the coalesced load. Channel
 * session cards mount one of these hooks per referenced session, so an
 * unhandled rejection there becomes an app-level error page rather than a
 * card that simply renders without a round count.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionTurnOverview } from "./useSessionTurnOverview";

const loadTurnIndex = vi.fn();

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadTurnIndex: (...args: unknown[]) => loadTurnIndex(...args),
}));

vi.mock("@src/store/session/cursorIdeTurnSummariesAtom", () => ({
  cursorIdeTurnSummariesAtomFamily: () => ({ init: [] }),
}));

// Stable reference: the hook's effect depends on this value, so a fresh array
// per render would re-fire the load forever.
const NO_CURSOR_TURNS: never[] = [];

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => NO_CURSOR_TURNS,
}));

vi.mock("@src/util/session/sessionDispatch", () => ({
  isCursorIdeSession: () => false,
}));

function Probe({ sessionId }: { sessionId: string }) {
  const overview = useSessionTurnOverview(sessionId);
  return createElement("div", {
    "data-testid": "probe",
    "data-turns": overview ? String(overview.turnCount) : "none",
  });
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let unhandled: unknown[] = [];

const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason);
};

beforeEach(() => {
  unhandled = [];
  window.addEventListener("unhandledrejection", onUnhandled);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", onUnhandled);
  act(() => root.unmount());
  container.remove();
  loadTurnIndex.mockReset();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useSessionTurnOverview", () => {
  it("reports the turn count for an indexed session", async () => {
    loadTurnIndex.mockResolvedValue([
      { durationMs: 1000 },
      { durationMs: 2000 },
    ]);
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "code-review-1" }));
    });
    await flush();

    expect(
      container
        .querySelector("[data-testid='probe']")
        ?.getAttribute("data-turns")
    ).toBe("2");
  });

  it("degrades to no overview when the turn index is missing, without an unhandled rejection", async () => {
    loadTurnIndex.mockRejectedValue(new Error("no turn index"));
    await act(async () => {
      root.render(createElement(Probe, { sessionId: "release-notes-1" }));
    });
    await flush();

    expect(
      container
        .querySelector("[data-testid='probe']")
        ?.getAttribute("data-turns")
    ).toBe("none");
    expect(unhandled).toEqual([]);
  });
});
