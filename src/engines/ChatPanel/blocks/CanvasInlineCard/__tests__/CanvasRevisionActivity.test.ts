// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import CanvasRevisionActivity from "../CanvasRevisionActivity";

const testState = vi.hoisted(() => ({
  locate: vi.fn(),
}));

vi.mock("@src/engines/ChatPanel/blocks/useBlockLocate", () => ({
  useBlockHeader: ({ eventId }: { eventId?: string }) => ({
    handleLocate: eventId ? testState.locate : vi.fn(),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      fallback: string,
      values?: Record<string, string | number>
    ) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.split(`{{${name}}}`).join(String(value)),
        fallback
      ),
  }),
}));

describe("CanvasRevisionActivity", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps a completed targeted-edit process visible in chat history", () => {
    const markup = renderToStaticMarkup(
      createElement(CanvasRevisionActivity, {
        eventId: "revision-a",
        status: "success",
        args: {
          title: "Coffee sketch",
          edits: [
            { find: "Start", replace: "Start setup" },
            { find: "13px", replace: "15px" },
          ],
          agent_steps: ["替换按钮文案", "核对原有交互"],
        },
      })
    );

    expect(markup).toContain('data-testid="canvas-revision-activity"');
    expect(markup).toContain("Updated Coffee sketch");
    expect(markup).toContain('title="Updated Coffee sketch"');
    expect(markup).toContain("truncate");
    expect(markup).toContain(
      '<span class="block min-w-0 truncate">Updated Coffee sketch</span>'
    );
    expect(markup).toContain("2 targeted changes");
    expect(markup).toContain(
      '<span class="block min-w-0 truncate">2 targeted changes · same Canvas</span>'
    );
    expect(markup).toContain("替换按钮文案");
    expect(markup).toContain("核对原有交互");
    expect(markup.match(/data-step-state="complete"/g)).toHaveLength(2);
  });

  it("shows a failed apply step and the validated failure detail", () => {
    const markup = renderToStaticMarkup(
      createElement(CanvasRevisionActivity, {
        eventId: "revision-a",
        status: "failed",
        args: {
          title: "Coffee sketch",
          agent_steps: ["替换完整画布", "验证结果"],
          content: "function App() {}",
        },
        errorDetail: "Exact source no longer matches",
      })
    );

    expect(markup).toContain("Couldn’t update Coffee sketch");
    expect(markup).toContain("Exact source no longer matches");
    expect(markup).toContain('data-step-state="failed"');
  });

  it("does not fabricate fixed steps for legacy revision events", () => {
    const markup = renderToStaticMarkup(
      createElement(CanvasRevisionActivity, {
        eventId: "revision-legacy",
        status: "success",
        args: { title: "Legacy", content: "function App() {}" },
      })
    );

    expect(markup).not.toContain("Canvas update progress");
    expect(markup).not.toContain("Locate existing Canvas");
    expect(markup).not.toContain("Generate change");
    expect(markup).not.toContain("Apply and validate");
  });

  it("truncates an individual agent label instead of overflowing", () => {
    const label = "一个需要在窄布局中被截断但仍能通过标题查看的动态步骤";
    const markup = renderToStaticMarkup(
      createElement(CanvasRevisionActivity, {
        eventId: "revision-a",
        status: "success",
        args: { agent_steps: [label], content: "function App() {}" },
      })
    );

    expect(markup).toContain(`title="${label}"`);
    expect(markup).toContain('class="min-w-0 truncate"');
  });

  it("reuses event replay navigation to open the corresponding Canvas", () => {
    testState.locate.mockReset();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(CanvasRevisionActivity, {
          eventId: "revision-a",
          status: "success",
          args: {
            title: "Coffee sketch",
            target_event_id: "canvas-a",
            edits: [{ find: "Start", replace: "Start setup" }],
          },
        })
      )
    );

    const navigate = container.querySelector<HTMLButtonElement>(
      "[data-testid='event-navigate']"
    );
    expect(navigate).not.toBeNull();
    act(() => navigate?.click());
    expect(testState.locate).toHaveBeenCalledTimes(1);

    const header = container.querySelector<HTMLElement>(".chat-block-header");
    act(() => header?.click());
    expect(testState.locate).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    container.remove();
  });

  it("stays non-interactive when the revision event has no stable id", () => {
    const markup = renderToStaticMarkup(
      createElement(CanvasRevisionActivity, {
        status: "success",
        args: { title: "Coffee sketch" },
      })
    );

    expect(markup).not.toContain('data-testid="event-navigate"');
    expect(markup).toContain("cursor-default");
  });
});
