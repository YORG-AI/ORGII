// @vitest-environment jsdom
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

import type { WorkItemHandoff } from "@src/api/http/project";

import WorkItemHandoffNotice from "../WorkItemHandoffNotice";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));

const HANDOFF: WorkItemHandoff = {
  id: "handoff-1",
  status: "pending",
  senderMemberId: "member-sender",
  senderName: "Ada",
  recipientMemberId: "member-recipient",
  recipientName: "Lin",
  note: "Continue the investigation.",
  requestedAt: "2026-07-28T10:00:00.000Z",
};

describe("WorkItemHandoffNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("shows the handoff context and recipient actions", () => {
    const onAccept = vi.fn();
    act(() => {
      root.render(
        createElement(WorkItemHandoffNotice, {
          handoff: HANDOFF,
          canRespond: true,
          onAccept,
          onReturn: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain(
      "teamInbox.handoff.pendingTitle:Ada"
    );
    expect(container.textContent).toContain("Continue the investigation.");
    const accept = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "teamInbox.handoff.accept"
    );
    act(() => accept?.click());
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("keeps status visible but hides decision actions for other viewers", () => {
    act(() => {
      root.render(
        createElement(WorkItemHandoffNotice, {
          handoff: HANDOFF,
          canRespond: false,
          onAccept: vi.fn(),
          onReturn: vi.fn(),
        })
      );
    });

    expect(
      container.querySelector('[data-testid="work-item-handoff-notice"]')
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "teamInbox.handoff.accept"
      )
    ).toBe(false);
  });

  it("explains why a targeted viewer cannot respond when identity is unresolved", () => {
    act(() => {
      root.render(
        createElement(WorkItemHandoffNotice, {
          handoff: HANDOFF,
          canRespond: false,
          unavailableReason: "Verify your project identity.",
          onAccept: vi.fn(),
          onReturn: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain("Verify your project identity.");
  });
});
