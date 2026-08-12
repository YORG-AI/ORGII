// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
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

import type { TeamMember } from "@src/components/TeamMemberTable";
import { activeOverlayCountAtom } from "@src/store/ui/overlayLayerAtom";

import MemberCommunicationPanel from "./MemberCommunicationPanel";
import { allMemberPairKeys } from "./orgTree";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { name?: string; defaultValue?: string }) =>
      args?.defaultValue ?? args?.name ?? key,
  }),
}));

const roster: TeamMember[] = [
  { id: "alice", name: "Alice", role: "Builder", agentId: "builtin:sde" },
  { id: "bob", name: "Bob", role: "Reviewer", agentId: "builtin:sde" },
  { id: "carol", name: "Carol", role: "Planner", agentId: "builtin:sde" },
];

describe("MemberCommunicationPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    store = createStore();
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

  const renderPanel = async (pairKeys: ReadonlySet<string>) => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(MemberCommunicationPanel, {
            selectedMemberId: "alice",
            members: roster,
            pairKeys,
            onPairChange: vi.fn(),
            onClose: vi.fn(),
          })
        )
      );
      await Promise.resolve();
    });
  };

  it("renders only the selected Member's peers with all new-Team pairs checked", async () => {
    await renderPanel(allMemberPairKeys(roster));

    expect(document.body.textContent).toContain("Alice communication");
    expect(
      document.querySelector('[data-testid="agent-orgs-peer-row-alice"]')
    ).toBeNull();
    expect(
      document.querySelectorAll('[data-testid^="agent-orgs-peer-row-"]')
    ).toHaveLength(2);
    expect(
      [
        ...document.querySelectorAll<HTMLInputElement>("[data-checkbox-input]"),
      ].every((input) => input.checked)
    ).toBe(true);
    expect(store.get(activeOverlayCountAtom)).toBe(1);
  });

  it("filters by role without changing hidden pair state", async () => {
    const pairs = allMemberPairKeys(roster);
    await renderPanel(pairs);
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="agent-orgs-communication-panel-search"]'
    );
    expect(search).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(search, "planner");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(
      document.querySelector('[data-testid="agent-orgs-peer-row-bob"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="agent-orgs-peer-row-carol"]')
    ).not.toBeNull();
    expect(pairs.size).toBe(3);
  });

  it("renders exactly 49 peers for a 50-Member Team", async () => {
    const largeRoster = Array.from({ length: 50 }, (_, index) => ({
      id: `member-${index}`,
      name: `Member ${index}`,
      role: "Builder",
      agentId: "builtin:sde",
    }));
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(MemberCommunicationPanel, {
            selectedMemberId: "member-0",
            members: largeRoster,
            pairKeys: allMemberPairKeys(largeRoster),
            onPairChange: vi.fn(),
            onClose: vi.fn(),
          })
        )
      );
      await Promise.resolve();
    });

    expect(
      document.querySelectorAll('[data-testid^="agent-orgs-peer-row-"]')
    ).toHaveLength(49);
    expect(document.querySelectorAll("[data-checkbox-input]")).toHaveLength(49);
  });

  it("closes on Escape, stops propagation, and returns focus to the opener", async () => {
    const opener = document.createElement("button");
    const onClose = vi.fn();
    document.body.appendChild(opener);
    opener.focus();
    const outerKeyHandler = vi.fn();
    document.body.addEventListener("keydown", outerKeyHandler);

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(MemberCommunicationPanel, {
            selectedMemberId: "alice",
            members: roster,
            pairKeys: allMemberPairKeys(roster),
            onPairChange: vi.fn(),
            onClose,
          })
        )
      );
      await Promise.resolve();
    });
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="agent-orgs-communication-panel-search"]'
    );
    expect(search).not.toBeNull();
    act(() => search?.focus());
    expect(document.activeElement).toBe(search);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      root.render(React.createElement(Provider, { store }, null));
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(outerKeyHandler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    document.body.removeEventListener("keydown", outerKeyHandler);
    opener.remove();
  });
});
