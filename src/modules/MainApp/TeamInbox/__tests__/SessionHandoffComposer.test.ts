// @vitest-environment jsdom
import React, { act, createElement } from "react";
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

import SessionHandoffComposer from "../components/SessionHandoffComposer";
import type { TeamInboxSessionHandoffDraft } from "../domain";
import {
  type SessionHandoffForm,
  createSessionHandoffForm,
} from "../sessionHandoffForm";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/scaffold/ModalSystem", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", { "data-testid": "modal" }, children),
}));

vi.mock("@src/components/Input", () => ({
  default: ({ value }: { value?: string }) =>
    createElement("input", { value, readOnly: true }),
}));

vi.mock("@src/components/Select", () => ({
  default: ({ dataTestId }: { dataTestId?: string }) =>
    createElement("button", { type: "button", "data-testid": dataTestId }),
}));

vi.mock("@src/components/Textarea", () => ({
  default: ({ value }: { value?: string }) =>
    createElement("textarea", { value, readOnly: true }),
}));

vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties",
  () => ({
    default: ({
      workItem,
      onUpdate,
      visibleFields,
      fieldVariant,
      pillLayout,
      showTime,
    }: {
      workItem: {
        workItemStatus?: string;
        priority?: string;
        endDate?: string;
      };
      onUpdate: (updates: Record<string, unknown>) => void;
      visibleFields?: string[];
      fieldVariant?: string;
      pillLayout?: string;
      showTime?: boolean;
    }) =>
      createElement(
        "div",
        {
          "data-testid": "shared-work-item-properties",
          "data-visible-fields": visibleFields?.join(","),
          "data-field-variant": fieldVariant,
          "data-pill-layout": pillLayout,
          "data-show-time": String(showTime),
          "data-status": workItem.workItemStatus,
          "data-priority": workItem.priority,
          "data-due-date": workItem.endDate,
        },
        createElement(
          "button",
          {
            type: "button",
            "data-testid": "update-shared-properties",
            onClick: () =>
              onUpdate({
                workItemStatus: "in_progress",
                priority: "urgent",
                endDate: "2026-07-31T00:00:00.000Z",
              }),
          },
          "Update"
        )
      ),
  })
);

const DRAFT: TeamInboxSessionHandoffDraft = {
  sessionId: "session-1",
  title: "Investigate sync",
  sourceDestinationKey: "project:project-alpha",
  destinations: [
    {
      kind: "project",
      key: "project:project-alpha",
      projectId: "project-1",
      projectSlug: "project-alpha",
      name: "Project Alpha",
      sender: {
        id: "member-me",
        name: "Me",
        isCurrentUser: true,
      },
      recipients: [
        { id: "member-me", name: "Me", isCurrentUser: true },
        { id: "member-lin", name: "Lin", isCurrentUser: false },
      ],
    },
  ],
  todoCount: 0,
};

describe("SessionHandoffComposer", () => {
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

  function renderComposer(
    form: SessionHandoffForm,
    onChange = vi.fn<(form: SessionHandoffForm) => void>(),
    submitting = false
  ) {
    act(() => {
      root.render(
        createElement(SessionHandoffComposer, {
          draft: DRAFT,
          form,
          submitting,
          onCancel: vi.fn(),
          onChange,
          onSubmit: vi.fn(),
        })
      );
    });
    return onChange;
  }

  it("uses the canonical Work Item property strip for status, priority, and due date", () => {
    renderComposer({
      ...createSessionHandoffForm(DRAFT),
      status: "in_review",
      priority: "high",
      targetDate: "2026-07-30T00:00:00.000Z",
    });

    const properties = container.querySelector(
      "[data-testid='shared-work-item-properties']"
    );
    expect(properties?.getAttribute("data-visible-fields")).toBe(
      "status,priority,date"
    );
    expect(properties?.getAttribute("data-field-variant")).toBe("pill");
    expect(properties?.getAttribute("data-pill-layout")).toBe("wrap");
    expect(properties?.getAttribute("data-show-time")).toBe("false");
    expect(properties?.getAttribute("data-status")).toBe("in_review");
    expect(properties?.getAttribute("data-priority")).toBe("high");
    expect(properties?.getAttribute("data-due-date")).toBe(
      "2026-07-30T00:00:00.000Z"
    );
  });

  it("maps shared property changes back without replacing handoff metadata", () => {
    const form = {
      ...createSessionHandoffForm(DRAFT),
      assigneeMemberId: "member-lin",
      note: "Keep this context",
    };
    const onChange = renderComposer(form);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='update-shared-properties']"
        )
        ?.click();
    });

    expect(onChange).toHaveBeenCalledWith({
      ...form,
      status: "in_progress",
      priority: "urgent",
      targetDate: "2026-07-31T00:00:00.000Z",
    });
  });

  it("locks property mutation while the handoff is submitting", () => {
    const form = createSessionHandoffForm(DRAFT);
    const onChange = renderComposer(form, undefined, true);

    const fieldset = container.querySelector(
      "[data-testid='team-inbox-handoff-properties']"
    );
    expect(fieldset?.hasAttribute("disabled")).toBe(true);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='update-shared-properties']"
        )
        ?.click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("explains why an invalid form cannot be submitted", () => {
    renderComposer({
      ...createSessionHandoffForm(DRAFT),
      assigneeMemberId: "removed-member",
    });

    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "teamInbox.handoff.validation.recipient_unavailable"
    );
  });
});
