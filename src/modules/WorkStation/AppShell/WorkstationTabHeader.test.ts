import { Provider, createStore } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { activeStatusBarAppAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";
import { workstationTabHeaderAtomByHost } from "@src/store/workstation";
import {
  type WorkStationTab,
  workstationTabsStateAtom,
} from "@src/store/workstation/tabs";
import { emptyWorkstationTabsState } from "@src/store/workstation/tabs/storage";

import WorkstationTabHeader from "./WorkstationTabHeader";

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./CodeSidebarHeaderActions", () => ({
  CodeSidebarHeaderActions: () => null,
}));

vi.mock("./SourceControlHeaderActions", () => ({
  SourceControlHeaderActions: () => null,
}));

function activateSourceControlTab(store: ReturnType<typeof createStore>) {
  const tab: WorkStationTab = {
    id: "source-control:changes",
    type: "source-control",
    title: "Review",
    data: {},
  };
  const state = emptyWorkstationTabsState();
  state.globalWorkspace = {
    tabs: [tab],
    activeTabRef: { partition: "workspace", tabId: tab.id },
    tabOrder: [{ partition: "workspace", tabId: tab.id }],
  };
  store.set(workstationTabsStateAtom, state);
}

describe("WorkstationTabHeader", () => {
  it("does not reserve the shell-wide row when an active split owns its header", () => {
    const store = createStore();
    store.set(activeStatusBarAppAtom, "code");
    store.set(workstationTabHeaderAtomByHost.code, { hidden: true });

    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store },
        React.createElement(WorkstationTabHeader)
      )
    );

    expect(markup).toBe("");
  });

  it("removes the unused shell-leading gutter for self-contained surfaces", () => {
    const store = createStore();
    store.set(activeStatusBarAppAtom, "code");
    store.set(workstationTabHeaderAtomByHost.code, {
      content: React.createElement("span", null, "Work Items"),
      shellLeadingChromeHidden: true,
    });

    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store },
        React.createElement(WorkstationTabHeader)
      )
    );

    expect(markup).toContain("Work Items");
    expect(markup).toContain("pl-0");
    expect(markup).not.toContain('data-icon="list"');
  });

  it("removes the published-header gutter for Source Control", () => {
    const store = createStore();
    store.set(activeStatusBarAppAtom, "code");
    store.set(workstationTabHeaderAtomByHost.code, {
      content: React.createElement("span", null, "develop"),
    });
    activateSourceControlTab(store);

    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store },
        React.createElement(WorkstationTabHeader)
      )
    );

    expect(markup).toContain("develop");
    expect(markup).toContain("pl-0");
    expect(markup).not.toContain("pl-2");
    expect(markup).not.toContain("pl-[15px]");
  });

  it("uses a compact My Station gutter without changing the shared default", () => {
    const store = createStore();
    store.set(activeStatusBarAppAtom, "code");
    store.set(workstationTabHeaderAtomByHost.code, {
      content: React.createElement("span", null, "My Station content"),
    });

    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store },
        React.createElement(WorkstationTabHeader)
      )
    );

    expect(markup).toContain("My Station content");
    expect(markup).toContain("pl-2");
    expect(markup).not.toContain("pl-[15px]");
  });
});
