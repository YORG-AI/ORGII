/**
 * @vitest-environment jsdom
 *
 * The WorkStation status bar renders for the whole shell, but the code host it
 * used to get its workspace affordances from now unmounts on the empty
 * Launchpad (`hostMountPolicy.ts`). These pin the affordances to the shell so
 * the workspace button keeps opening GlobalSpotlight with no host mounted.
 */
import { Provider } from "jotai";
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { useWorkStationPanels } from "@src/hooks/tabHost/useWorkStationPanels";
import {
  spotlightInitialQueryAtom,
  spotlightOpenAtom,
} from "@src/store/ui/uiAtom";
import { perAppStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { createSmokeRoot, dispatch } from "../../../../test/reactSmokeHarness";
import { useAppShellStatusBar } from "./useAppShellStatusBar";

const store = createInstrumentedStore();

const panels = {
  togglePrimarySidebar: () => {},
  toggleBottomPanel: () => {},
  layoutMode: "left",
  bottomPanelCollapsed: false,
} as unknown as ReturnType<typeof useWorkStationPanels>;

function Harness() {
  useAppShellStatusBar({
    primaryPanelCollapsed: false,
    showSettingsButton: false,
    handleOpenSettings: () => {},
    workStationPanels: panels,
  });
  return null;
}

async function mountShell() {
  const root = createSmokeRoot();
  await root.render(
    React.createElement(Provider, { store }, React.createElement(Harness))
  );
  return root;
}

describe("useAppShellStatusBar", () => {
  beforeEach(() => {
    store.set(spotlightOpenAtom, false);
    store.set(spotlightInitialQueryAtom, null);
  });

  it("opens the workspace spotlight with no code host mounted", async () => {
    const root = await mountShell();

    const onRepoClick = store.get(perAppStatusBarCallbacksAtom).code
      .onRepoClick;
    expect(onRepoClick).toBeTypeOf("function");

    await dispatch(() => onRepoClick?.());

    expect(store.get(spotlightOpenAtom)).toBe(true);
    expect(store.get(spotlightInitialQueryAtom)?.layer).toEqual({
      kind: "workspace",
      mode: "switch",
    });

    await root.unmount();
  });

  it("registers the branch and worktree openers alongside it", async () => {
    const root = await mountShell();
    const callbacks = store.get(perAppStatusBarCallbacksAtom).code;

    await dispatch(() => callbacks.onWorktreeClick?.());
    expect(store.get(spotlightInitialQueryAtom)?.layer).toEqual({
      kind: "worktree",
    });

    await dispatch(() => callbacks.onBranchClick?.());
    expect(store.get(spotlightInitialQueryAtom)?.layer).toEqual({
      kind: "branch",
    });

    await root.unmount();
  });
});
