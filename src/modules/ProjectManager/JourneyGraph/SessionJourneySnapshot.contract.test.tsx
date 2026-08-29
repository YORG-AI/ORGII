// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { SessionJourneySnapshot } from "./SessionJourneySnapshot";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("@src/api/tauri/sessionJourney", () => ({
  sessionJourneyApi: { snapshot: mocks.snapshot },
}));

describe("SessionJourneySnapshot", () => {
  it("clears the old session immediately and ignores its late completion", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    mocks.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    mocks.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        })
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(<SessionJourneySnapshot sessionId="one" />)
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () =>
      root.render(<SessionJourneySnapshot sessionId="two" />)
    );
    expect(container.textContent).toContain("正在加载会话旅程");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () =>
      resolveFirst({
        snapshot: {
          revision: 1,
          tasks: {},
          branches: {},
          checkpoints: {},
          reviews: {},
        },
      })
    );
    expect(container.textContent).toContain("正在加载会话旅程");
    await act(async () =>
      resolveSecond({
        snapshot: {
          revision: 2,
          tasks: {},
          branches: {},
          checkpoints: {},
          reviews: {},
        },
      })
    );
    expect(container.textContent).toContain("修订 2");
    await act(async () => root.unmount());
  });
});
