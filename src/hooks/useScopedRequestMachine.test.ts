// @vitest-environment jsdom
import React, {
  act,
  createElement,
  createRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ScopedRequestState,
  resolutionForScope,
  scopedRequestReducer,
  useScopedRequestMachine,
} from "./useScopedRequestMachine";

interface Row {
  id: string;
}

const loading: ScopedRequestState<Row[]> = {
  scopeKey: null,
  resolution: { phase: "loading", data: null, error: null },
  refreshing: false,
};

type MachineHandle = ReturnType<typeof useScopedRequestMachine<Row[]>>;

const MachineProbe = forwardRef<MachineHandle>(function MachineProbe(_, ref) {
  const machine = useScopedRequestMachine<Row[]>();
  useImperativeHandle(ref, () => machine, [machine]);
  return createElement("div", {
    "data-testid": "scoped-request-probe",
    "data-scope": machine.state.scopeKey ?? "",
    "data-phase": machine.state.resolution.phase,
    "data-refreshing": String(machine.state.refreshing),
  });
});

describe("scopedRequestReducer", () => {
  it("retains ready rows only while revalidating the same scope", () => {
    const ready = scopedRequestReducer(
      scopedRequestReducer(loading, {
        type: "start",
        scopeKey: "identity-a|org-a",
      }),
      { type: "success", data: [{ id: "member-a" }] }
    );

    const revalidating = scopedRequestReducer(ready, {
      type: "start",
      scopeKey: "identity-a|org-a",
    });
    expect(revalidating).toMatchObject({
      scopeKey: "identity-a|org-a",
      refreshing: true,
      resolution: { phase: "ready", data: [{ id: "member-a" }] },
    });

    const switched = scopedRequestReducer(revalidating, {
      type: "start",
      scopeKey: "identity-b|org-a",
    });
    expect(switched).toEqual({
      scopeKey: "identity-b|org-a",
      refreshing: true,
      resolution: { phase: "loading", data: null, error: null },
    });
    expect(resolutionForScope(revalidating, "identity-b|org-a")).toEqual({
      phase: "loading",
      data: null,
      error: null,
    });
  });

  it("keeps retained rows with an error after background revalidation fails", () => {
    const ready: ScopedRequestState<Row[]> = {
      scopeKey: "identity-a|org-a",
      refreshing: true,
      resolution: {
        phase: "ready",
        data: [{ id: "member-a" }],
        error: null,
      },
    };

    expect(
      scopedRequestReducer(ready, { type: "failure", error: "offline" })
    ).toEqual({
      scopeKey: "identity-a|org-a",
      refreshing: true,
      resolution: {
        phase: "ready",
        data: [{ id: "member-a" }],
        error: "offline",
      },
    });
  });
});

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useScopedRequestMachine generation gate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handle: React.RefObject<MachineHandle | null>;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    handle = createRef<MachineHandle>();
    act(() => root.render(createElement(MachineProbe, { ref: handle })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("drops every terminal signal from the previous scope generation", () => {
    let oldGeneration = 0;
    let currentGeneration = 0;
    act(() => {
      oldGeneration = handle.current!.begin("identity-a|org-a");
      currentGeneration = handle.current!.begin("identity-b|org-a");
      handle.current!.commit(oldGeneration, {
        type: "failure",
        error: "stale failure",
      });
      handle.current!.commit(oldGeneration, { type: "unsupported" });
      handle.current!.commit(oldGeneration, { type: "finish" });
    });

    expect(handle.current!.state).toEqual({
      scopeKey: "identity-b|org-a",
      resolution: { phase: "loading", data: null, error: null },
      refreshing: true,
    });

    act(() => {
      handle.current!.commit(currentGeneration, {
        type: "success",
        data: [{ id: "member-b" }],
      });
      handle.current!.commit(currentGeneration, { type: "finish" });
    });

    expect(handle.current!.state).toEqual({
      scopeKey: "identity-b|org-a",
      resolution: {
        phase: "ready",
        data: [{ id: "member-b" }],
        error: null,
      },
      refreshing: false,
    });
  });
});
