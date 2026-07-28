import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";

import {
  clearTerminalTargetForWorkspaceAtom,
  clearTerminalTargetReferencesAtom,
  codeEditorTerminalTargetAtom,
  codeEditorTerminalTargetsAtom,
} from "../../terminalTargetAtom";

describe("workspace-scoped terminal target", () => {
  it("does not leak an agent terminal from Session A into Session B or Global", () => {
    const store = createStore();

    store.set(workstationActiveSessionIdAtom, "A");
    store.set(codeEditorTerminalTargetAtom, {
      kind: "agent",
      sessionId: "agent-A",
    });

    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(codeEditorTerminalTargetAtom)).toBeNull();
    store.set(codeEditorTerminalTargetAtom, {
      kind: "agent",
      sessionId: "agent-B",
    });

    store.set(workstationActiveSessionIdAtom, null);
    expect(store.get(codeEditorTerminalTargetAtom)).toBeNull();

    store.set(workstationActiveSessionIdAtom, "A");
    expect(store.get(codeEditorTerminalTargetAtom)).toEqual({
      kind: "agent",
      sessionId: "agent-A",
    });
  });

  it("remembers a workspace PTY selection without changing another workspace", () => {
    const store = createStore();

    store.set(workstationActiveSessionIdAtom, "A");
    store.set(codeEditorTerminalTargetAtom, {
      kind: "pty",
      ptySessionId: "pty-A",
    });
    store.set(workstationActiveSessionIdAtom, "B");
    store.set(codeEditorTerminalTargetAtom, {
      kind: "pty",
      ptySessionId: "pty-B",
    });

    store.set(workstationActiveSessionIdAtom, "A");
    expect(store.get(codeEditorTerminalTargetAtom)).toEqual({
      kind: "pty",
      ptySessionId: "pty-A",
    });
    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(codeEditorTerminalTargetAtom)).toEqual({
      kind: "pty",
      ptySessionId: "pty-B",
    });
  });

  it("clears a killed PTY from every workspace that references it", () => {
    const store = createStore();
    store.set(codeEditorTerminalTargetsAtom, {
      "session:A": { kind: "pty", ptySessionId: "shared-pty" },
      "session:B": { kind: "pty", ptySessionId: "shared-pty" },
      global: { kind: "pty", ptySessionId: "other-pty" },
    });

    store.set(clearTerminalTargetReferencesAtom, "shared-pty");

    expect(store.get(codeEditorTerminalTargetsAtom)).toEqual({
      global: { kind: "pty", ptySessionId: "other-pty" },
    });
  });

  it("clears only the deleted agent workspace selection", () => {
    const store = createStore();
    store.set(codeEditorTerminalTargetsAtom, {
      "session:A": { kind: "agent", sessionId: "agent-A" },
      "session:B": { kind: "agent", sessionId: "agent-B" },
    });

    store.set(clearTerminalTargetForWorkspaceAtom, "A");

    expect(store.get(codeEditorTerminalTargetsAtom)).toEqual({
      "session:B": { kind: "agent", sessionId: "agent-B" },
    });
  });
});
