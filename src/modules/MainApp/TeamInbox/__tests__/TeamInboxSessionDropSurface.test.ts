// @vitest-environment jsdom
import { getDefaultStore } from "jotai";
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

import {
  SESSION_TAB_DRAG_CANCEL_EVENT,
  SESSION_TAB_DRAG_END_EVENT,
  SESSION_TAB_DRAG_START_EVENT,
  type SessionTabDragEndDetail,
  type SessionTabDragStartDetail,
  type SessionTabTransfer,
} from "@src/shared/dnd/sessionTabDrag";

import TeamInboxSessionDropSurface from "../components/TeamInboxSessionDropSurface";
import type {
  TeamInboxDataSource,
  TeamInboxSessionHandoffDraft,
} from "../domain";
import { SessionHandoffPreparationError } from "../sessionHandoffError";
import {
  requestTeamInboxSessionHandoffAtom,
  teamInboxSessionHandoffRequestAtom,
} from "../store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../components/SessionHandoffComposer", () => ({
  default: ({
    error,
    form,
    onChange,
    onSubmit,
  }: {
    error?: string | null;
    form: {
      title: string;
      destinationKey: string;
      assigneeMemberId: string;
      note: string;
    };
    onChange: (form: {
      title: string;
      destinationKey: string;
      assigneeMemberId: string;
      note: string;
    }) => void;
    onSubmit: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "team-inbox-session-handoff-composer" },
      error ? createElement("p", null, error) : null,
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onChange({
              ...form,
              assigneeMemberId: "member-teammate",
              note: "Continue from the failing test.",
            }),
        },
        "assign teammate"
      ),
      createElement(
        "button",
        { type: "button", onClick: onSubmit },
        "submit handoff"
      )
    ),
}));

const TRANSFER: SessionTabTransfer = {
  source: "chat-panel",
  sourceTabId: "tab-1",
  sessionId: "session-1",
  title: "Fix Team Inbox",
};

const DRAFT: TeamInboxSessionHandoffDraft = {
  sessionId: TRANSFER.sessionId,
  title: TRANSFER.title,
  sourceDestinationKey: "project:project",
  destinations: [
    {
      kind: "project",
      key: "project:project",
      projectId: "project-id",
      projectSlug: "project",
      name: "Project",
      sender: {
        id: "member-me",
        name: "Me",
        isCurrentUser: true,
      },
      recipients: [
        {
          id: "member-me",
          name: "Me",
          isCurrentUser: true,
        },
        {
          id: "member-teammate",
          name: "Teammate",
          isCurrentUser: false,
        },
      ],
    },
  ],
  todoCount: 0,
};

function dataSource(
  overrides: Partial<TeamInboxDataSource> = {}
): TeamInboxDataSource {
  return {
    listPage: async () => ({ items: [], nextCursor: null }),
    prepareSessionHandoff: vi.fn(async () => DRAFT),
    createWorkItemFromSession: vi.fn(async () => ({
      projectId: "project",
      workItemId: "PRO-0001",
      reused: false,
    })),
    ...overrides,
  };
}

function dispatchDrop(): void {
  document.dispatchEvent(
    new CustomEvent<SessionTabDragStartDetail>(SESSION_TAB_DRAG_START_EVENT, {
      detail: { transfer: TRANSFER },
    })
  );
  document.dispatchEvent(
    new CustomEvent<SessionTabDragEndDetail>(SESSION_TAB_DRAG_END_EVENT, {
      detail: { transfer: TRANSFER, clientX: 50, clientY: 50 },
    })
  );
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe("TeamInboxSessionDropSurface", () => {
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
    getDefaultStore().set(teamInboxSessionHandoffRequestAtom, null);
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderSurface(source: TeamInboxDataSource): HTMLDivElement {
    act(() => {
      root.render(
        createElement(
          TeamInboxSessionDropSurface,
          { dataSource: source },
          createElement("div", null, "Inbox")
        )
      );
    });
    const surface = container.firstElementChild as HTMLDivElement;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });
    return surface;
  }

  it("previews the Session, then submits the selected teammate handoff once", async () => {
    let resolveCreation:
      | ((result: {
          projectId: string;
          workItemId: string;
          reused: boolean;
        }) => void)
      | undefined;
    const createWorkItemFromSession = vi.fn(
      () =>
        new Promise<{
          projectId: string;
          workItemId: string;
          reused: boolean;
        }>((resolve) => {
          resolveCreation = resolve;
        })
    );
    const source = dataSource({ createWorkItemFromSession });

    renderSurface(source);
    await act(async () => {
      dispatchDrop();
      await Promise.resolve();
    });

    expect(source.prepareSessionHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        title: "Fix Team Inbox",
        signal: expect.any(AbortSignal),
      })
    );
    expect(
      container.querySelector(
        '[data-testid="team-inbox-session-handoff-composer"]'
      )
    ).not.toBeNull();

    act(() => findButton(container, "assign teammate").click());
    act(() => findButton(container, "submit handoff").click());

    expect(createWorkItemFromSession).toHaveBeenCalledOnce();
    expect(createWorkItemFromSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        title: "Fix Team Inbox",
        destinationKey: "project:project",
        assigneeMemberId: "member-teammate",
        handoffNote: "Continue from the failing test.",
        signal: expect.any(AbortSignal),
      })
    );

    await act(async () => {
      resolveCreation?.({
        projectId: "project",
        workItemId: "PRO-0001",
        reused: false,
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="team-inbox-session-drop-success"]')
    ).not.toBeNull();
  });

  it("shows a transient Drop Zone and cancels without preparing", () => {
    const source = dataSource();
    renderSurface(source);

    act(() => {
      document.dispatchEvent(
        new CustomEvent<SessionTabDragStartDetail>(
          SESSION_TAB_DRAG_START_EVENT,
          { detail: { transfer: TRANSFER } }
        )
      );
    });
    expect(
      container.querySelector('[data-testid="team-inbox-session-drop-zone"]')
    ).not.toBeNull();

    act(() => {
      document.dispatchEvent(new Event(SESSION_TAB_DRAG_CANCEL_EVENT));
    });
    expect(
      container.querySelector('[data-testid="team-inbox-session-drop-zone"]')
    ).toBeNull();
    expect(source.prepareSessionHandoff).not.toHaveBeenCalled();
    expect(source.createWorkItemFromSession).not.toHaveBeenCalled();
  });

  it("shows an actionable reason when no eligible project exists", async () => {
    const source = dataSource({
      prepareSessionHandoff: vi.fn(() =>
        Promise.reject(new SessionHandoffPreparationError("no_project"))
      ),
    });
    renderSurface(source);

    await act(async () => {
      dispatchDrop();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "teamInbox.handoff.preparationError.no_project"
    );
    expect(findButton(container, "common:actions.retry")).toBeDefined();
  });

  it("opens the same review composer from the non-drag Session action", async () => {
    const source = dataSource();
    renderSurface(source);

    await act(async () => {
      getDefaultStore().set(requestTeamInboxSessionHandoffAtom, {
        sessionId: TRANSFER.sessionId,
        title: TRANSFER.title,
      });
      await Promise.resolve();
    });

    expect(source.prepareSessionHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: TRANSFER.sessionId,
        title: TRANSFER.title,
      })
    );
    expect(
      container.querySelector(
        '[data-testid="team-inbox-session-handoff-composer"]'
      )
    ).not.toBeNull();
    expect(
      getDefaultStore().get(teamInboxSessionHandoffRequestAtom)
    ).toBeNull();
  });

  it("retains the configured handoff after a submit failure for an idempotent retry", async () => {
    const createWorkItemFromSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce({
        projectId: "project",
        workItemId: "PRO-0001",
        reused: true,
      });
    const source = dataSource({ createWorkItemFromSession });
    renderSurface(source);

    await act(async () => {
      dispatchDrop();
      await Promise.resolve();
    });
    act(() => findButton(container, "assign teammate").click());
    await act(async () => {
      findButton(container, "submit handoff").click();
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="team-inbox-session-handoff-composer"]'
      )
    ).not.toBeNull();
    expect(container.textContent).toContain("teamInbox.handoff.submitError");

    await act(async () => {
      findButton(container, "submit handoff").click();
      await Promise.resolve();
    });
    expect(createWorkItemFromSession).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="team-inbox-session-drop-success"]')
    ).not.toBeNull();
  });

  it("aborts preparation and ignores its stale completion when scope changes", async () => {
    let resolvePreparation:
      | ((draft: TeamInboxSessionHandoffDraft) => void)
      | undefined;
    let observedSignal: AbortSignal | undefined;
    const firstDataSource = dataSource({
      prepareSessionHandoff: vi.fn(
        (input: { signal?: AbortSignal }) =>
          new Promise<TeamInboxSessionHandoffDraft>((resolve) => {
            observedSignal = input.signal;
            resolvePreparation = resolve;
          })
      ),
    });

    renderSurface(firstDataSource);
    act(dispatchDrop);
    expect(observedSignal?.aborted).toBe(false);

    await act(async () => {
      root.render(
        createElement(
          TeamInboxSessionDropSurface,
          { dataSource: dataSource() },
          createElement("div", null, "Other scope")
        )
      );
      await Promise.resolve();
    });
    expect(observedSignal?.aborted).toBe(true);

    await act(async () => {
      resolvePreparation?.(DRAFT);
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        '[data-testid="team-inbox-session-handoff-composer"]'
      )
    ).toBeNull();
  });
});
