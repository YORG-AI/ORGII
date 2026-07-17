import type { Terminal } from "@xterm/xterm";
import type { RefObject } from "react";
import { describe, expect, it, vi } from "vitest";

import { runForLiveTerminal } from "./useTerminalAppearance";

function terminalRef(current: Terminal | null): RefObject<Terminal | null> {
  return { current };
}

describe("runForLiveTerminal", () => {
  it("runs an update only for the currently mounted xterm instance", () => {
    const terminal = {} as Terminal;
    const operation = vi.fn();

    expect(runForLiveTerminal(terminalRef(terminal), terminal, operation)).toBe(
      true
    );
    expect(operation).toHaveBeenCalledOnce();
  });

  it("ignores an async callback for a replaced renderer", () => {
    const stale = {} as Terminal;
    const live = {} as Terminal;
    const operation = vi.fn();

    expect(runForLiveTerminal(terminalRef(live), stale, operation)).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });

  it("contains xterm renderer races instead of reaching the app boundary", () => {
    const terminal = {} as Terminal;

    expect(
      runForLiveTerminal(terminalRef(terminal), terminal, () => {
        throw new TypeError("renderer disposed");
      })
    ).toBe(false);
  });
});
