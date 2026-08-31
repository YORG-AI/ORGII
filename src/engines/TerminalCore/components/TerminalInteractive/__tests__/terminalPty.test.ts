import { describe, expect, it, vi } from "vitest";

import { writeToLiveTerminal } from "../terminalPty";

describe("PTY terminal lifecycle", () => {
  it("drops a queued write after the terminal instance is replaced", () => {
    const oldTerminal = { write: vi.fn() };
    const replacement = { write: vi.fn() };
    const terminalRef = { current: replacement };

    const written = writeToLiveTerminal(
      terminalRef as never,
      oldTerminal as never,
      () => false,
      "stale output"
    );

    expect(written).toBe(false);
    expect(oldTerminal.write).not.toHaveBeenCalled();
    expect(replacement.write).not.toHaveBeenCalled();
  });

  it("drops writes after abort and contains a disposed-renderer exception", () => {
    const abortedTerminal = { write: vi.fn() };
    const abortedRef = { current: abortedTerminal };
    expect(
      writeToLiveTerminal(
        abortedRef as never,
        abortedTerminal as never,
        () => true,
        "late output"
      )
    ).toBe(false);
    expect(abortedTerminal.write).not.toHaveBeenCalled();

    const disposedTerminal = {
      write: vi.fn(() => {
        throw new TypeError("renderer disposed");
      }),
    };
    const disposedRef = { current: disposedTerminal };
    expect(
      writeToLiveTerminal(
        disposedRef as never,
        disposedTerminal as never,
        () => false,
        "racing output"
      )
    ).toBe(false);
    expect(disposedTerminal.write).toHaveBeenCalledOnce();
  });

  it("writes to the current live terminal", () => {
    const terminal = { write: vi.fn() };
    const terminalRef = { current: terminal };

    expect(
      writeToLiveTerminal(
        terminalRef as never,
        terminal as never,
        () => false,
        "live output"
      )
    ).toBe(true);
    expect(terminal.write).toHaveBeenCalledWith("live output");
  });
});
