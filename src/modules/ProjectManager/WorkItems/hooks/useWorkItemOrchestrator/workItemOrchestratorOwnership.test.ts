// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  claimWorkItemOrchestratorAction,
  getWorkItemOrchestratorOwnershipCount,
  isWorkItemOrchestratorOwner,
  releaseWorkItemOrchestratorAction,
  resetWorkItemOrchestratorOwnership,
  retainWorkItemOrchestratorOwnership,
  useWorkItemOrchestratorOwnership,
} from "./workItemOrchestratorOwnership";

function OwnershipProbe({
  label,
  ownershipKey,
  store,
}: {
  label: string;
  ownershipKey: string;
  store: ReturnType<typeof createStore>;
}) {
  const ownsSideEffects = useWorkItemOrchestratorOwnership(store, ownershipKey);
  return createElement("div", {
    "data-testid": label,
    "data-owns-side-effects": String(ownsSideEffects),
  });
}

describe("workItemOrchestratorOwnership", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => resetWorkItemOrchestratorOwnership());

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("elects one owner, hands off on release, and drops the final entry", () => {
    const store = createStore();
    const first = Symbol("first");
    const second = Symbol("second");
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const releaseFirst = retainWorkItemOrchestratorOwnership(
      store,
      "project:item",
      first,
      firstListener
    );
    const releaseSecond = retainWorkItemOrchestratorOwnership(
      store,
      "project:item",
      second,
      secondListener
    );

    expect(isWorkItemOrchestratorOwner(store, "project:item", first)).toBe(
      true
    );
    expect(isWorkItemOrchestratorOwner(store, "project:item", second)).toBe(
      false
    );
    expect(getWorkItemOrchestratorOwnershipCount(store)).toBe(1);
    expect(
      claimWorkItemOrchestratorAction(store, "project:item", "auto-review")
    ).toBe(true);
    expect(
      claimWorkItemOrchestratorAction(store, "project:item", "auto-review")
    ).toBe(false);

    releaseFirst();
    expect(isWorkItemOrchestratorOwner(store, "project:item", second)).toBe(
      true
    );
    expect(secondListener).toHaveBeenCalledOnce();
    expect(
      claimWorkItemOrchestratorAction(store, "project:item", "auto-review")
    ).toBe(false);
    releaseWorkItemOrchestratorAction(store, "project:item", "auto-review");
    expect(
      claimWorkItemOrchestratorAction(store, "project:item", "auto-review")
    ).toBe(true);

    releaseSecond();
    expect(getWorkItemOrchestratorOwnershipCount(store)).toBe(0);
  });

  it("hands hook ownership to the remaining rendered surface", async () => {
    const store = createStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const ownershipKey = "project:item:session";
    const probe = (label: string) =>
      createElement(OwnershipProbe, {
        key: label,
        label,
        ownershipKey,
        store,
      });

    await act(async () => {
      root.render(
        createElement(Provider, { store }, probe("first"), probe("second"))
      );
    });
    expect(
      container
        .querySelector("[data-testid='first']")
        ?.getAttribute("data-owns-side-effects")
    ).toBe("true");
    expect(
      container
        .querySelector("[data-testid='second']")
        ?.getAttribute("data-owns-side-effects")
    ).toBe("false");

    await act(async () => {
      root.render(createElement(Provider, { store }, probe("second")));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='second']")
          ?.getAttribute("data-owns-side-effects")
      ).toBe("true");
    });

    act(() => root.unmount());
    container.remove();
    expect(getWorkItemOrchestratorOwnershipCount(store)).toBe(0);
  });
});
