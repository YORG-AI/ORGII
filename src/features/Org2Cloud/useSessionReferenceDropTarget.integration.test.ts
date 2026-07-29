// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act, useRef } from "react";
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

import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import { buildCloudSessionReference } from "./cloudSessionReference";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { useSessionReferenceDropTarget } from "./useSessionReferenceDropTarget";

vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn() },
}));

vi.mock("@src/i18n", () => ({
  default: { t: (key: string) => key },
}));

const TEAM_REFERENCE = buildCloudSessionReference({
  orgId: "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "codexapp-rollout-2026-07-27T13-57-08",
});

function Harness({ onInsertText }: { onInsertText: (text: string) => void }) {
  const targetRef = useRef<HTMLDivElement>(null);
  const { isDragOver } = useSessionReferenceDropTarget({
    elementRef: targetRef,
    onInsertText,
  });
  // eslint-disable-next-line react-hooks/refs -- createElement is required because Vitest only includes `.test.ts`; this is a normal React ref prop.
  return React.createElement("div", {
    ref: targetRef,
    "data-testid": "target",
    "data-drag-over": String(isDragOver),
  });
}

describe("useSessionReferenceDropTarget custom editor target", () => {
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
    localStorage.clear();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("inserts a teammate session reference into a non-textarea editor", () => {
    const onInsertText = vi.fn();
    const store = createStore();
    store.set(org2CloudAuthAtom, {
      kind: "org2_cloud",
      supabaseUrl: "https://cloud.example.test",
      supabaseAnonKey: "anon",
      userId: "viewer",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 4_000_000_000,
    });

    act(() => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { onInsertText })
        )
      );
    });

    const target = container.querySelector<HTMLElement>(
      '[data-testid="target"]'
    );
    expect(target).not.toBeNull();
    vi.spyOn(target!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 200,
      bottom: 100,
      left: 0,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });

    const detail: TabDragEventDetail = {
      tabId: "team-session",
      pill: {
        path: TEAM_REFERENCE,
        name: "Teammate session",
        iconType: "session",
      },
      pointerX: 50,
      pointerY: 50,
    };
    act(() => {
      document.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 50, clientY: 50 })
      );
    });
    expect(target?.getAttribute("data-drag-over")).toBe("false");

    act(() => {
      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-start", { detail })
      );
      document.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 50, clientY: 50 })
      );
    });
    expect(target?.getAttribute("data-drag-over")).toBe("true");

    act(() => {
      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-end", { detail })
      );
    });

    expect(target?.getAttribute("data-drag-over")).toBe("false");
    expect(onInsertText).toHaveBeenCalledOnce();
    expect(onInsertText).toHaveBeenCalledWith(TEAM_REFERENCE);
  });
});
