import { describe, expect, it } from "vitest";

import type { TerminalSession } from "@src/engines/TerminalCore/types";

import { resolveRestoredPtySessionId } from "./restorePtySelection";

function terminal(id: string): TerminalSession {
  return { id, name: id, isActive: false };
}

describe("resolveRestoredPtySessionId", () => {
  const sessions = [terminal("pty-A"), terminal("pty-B")];

  it("restores the PTY remembered by the selected workspace", () => {
    expect(
      resolveRestoredPtySessionId(
        { kind: "pty", ptySessionId: "pty-A" },
        sessions,
        "pty-B"
      )
    ).toBe("pty-A");
  });

  it("does not reselect the already active PTY", () => {
    expect(
      resolveRestoredPtySessionId(
        { kind: "pty", ptySessionId: "pty-A" },
        sessions,
        "pty-A"
      )
    ).toBeNull();
  });

  it("ignores agent targets and stale PTY references", () => {
    expect(
      resolveRestoredPtySessionId(
        { kind: "agent", sessionId: "agent-A" },
        sessions,
        "pty-B"
      )
    ).toBeNull();
    expect(
      resolveRestoredPtySessionId(
        { kind: "pty", ptySessionId: "closed-pty" },
        sessions,
        "pty-B"
      )
    ).toBeNull();
  });
});
