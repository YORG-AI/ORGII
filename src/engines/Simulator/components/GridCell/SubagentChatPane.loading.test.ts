// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { SubagentChatPane } from "./SubagentChatPane";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));
vi.mock(
  "@src/engines/SessionCore/derived/sessionScopedChatEvents",
  async () => {
    const { atom } = await import("jotai");
    const empty = atom([]);
    return { chatEventsForSessionAtomFamily: () => empty };
  }
);
vi.mock("@src/engines/ChatPanel/ChatHistory", () => ({ default: () => null }));
vi.mock("./SubagentPromptToggle", () => ({ SubagentPromptToggle: () => null }));
it("distinguishes loading, retryable failure and confirmed empty history", () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const retry = vi.fn();
  const render = (status: "loading" | "ready" | "error") =>
    act(() =>
      root.render(
        createElement(SubagentChatPane, {
          sessionId: "child",
          historyLoad: { status, retry },
        })
      )
    );
  try {
    render("loading");
    expect(host.textContent).toContain("Loading history");
    render("error");
    expect(host.textContent).toContain("Couldn’t load history");
    act(() => host.querySelector("button")?.click());
    expect(retry).toHaveBeenCalledOnce();
    render("ready");
    expect(host.textContent).toContain("Waiting for activity");
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
  }
});
