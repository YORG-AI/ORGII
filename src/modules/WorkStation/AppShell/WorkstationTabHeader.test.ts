import { Provider, createStore } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { activeStatusBarAppAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";
import { workstationTabHeaderAtomByHost } from "@src/store/workstation";

import WorkstationTabHeader from "./WorkstationTabHeader";

describe("WorkstationTabHeader", () => {
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
    expect(markup).not.toContain("lucide-list");
  });
});
