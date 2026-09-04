import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTests,
  observePtyOutput,
  publishPtyOutput,
} from "../ptyOutputBus";

afterEach(() => {
  _resetForTests();
});

describe("pty output bus", () => {
  it("delivers a chunk to an observer of that session", () => {
    const observer = vi.fn();
    observePtyOutput("terminal-pty-a", observer);

    publishPtyOutput("terminal-pty-a", "listening on 3000");

    expect(observer).toHaveBeenCalledWith("listening on 3000");
  });

  it("keeps sessions apart", () => {
    const observer = vi.fn();
    observePtyOutput("terminal-pty-a", observer);

    publishPtyOutput("terminal-pty-b", "other session");

    expect(observer).not.toHaveBeenCalled();
  });

  it("fans one chunk out to every observer", () => {
    const first = vi.fn();
    const second = vi.fn();
    observePtyOutput("terminal-pty-a", first);
    observePtyOutput("terminal-pty-a", second);

    publishPtyOutput("terminal-pty-a", "x");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unsubscribe", () => {
    const observer = vi.fn();
    const unobserve = observePtyOutput("terminal-pty-a", observer);

    unobserve();
    publishPtyOutput("terminal-pty-a", "x");

    expect(observer).not.toHaveBeenCalled();
  });

  it("still notifies later observers when an earlier one unsubscribes itself", () => {
    const seen: string[] = [];
    let unobserveFirst = () => {};
    unobserveFirst = observePtyOutput("terminal-pty-a", () => {
      seen.push("first");
      unobserveFirst();
    });
    observePtyOutput("terminal-pty-a", () => {
      seen.push("second");
    });

    publishPtyOutput("terminal-pty-a", "x");

    expect(seen).toEqual(["first", "second"]);
  });

  it("does not let a failing observer break the terminal write path", () => {
    const healthy = vi.fn();
    observePtyOutput("terminal-pty-a", () => {
      throw new Error("observer exploded");
    });
    observePtyOutput("terminal-pty-a", healthy);

    expect(() => publishPtyOutput("terminal-pty-a", "x")).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("is a cheap no-op when nothing is observing", () => {
    expect(() => publishPtyOutput("terminal-pty-unwatched", "x")).not.toThrow();
  });

  it("drops the last unsubscribe rather than leaking an empty session entry", () => {
    const unobserve = observePtyOutput("terminal-pty-a", vi.fn());
    unobserve();

    // Re-subscribing must still work after the session's set was cleaned up.
    const observer = vi.fn();
    observePtyOutput("terminal-pty-a", observer);
    publishPtyOutput("terminal-pty-a", "x");

    expect(observer).toHaveBeenCalledTimes(1);
  });
});
