import { describe, expect, it, vi } from "vitest";

import { createLatestOnlySearchRunner } from "./latestOnlySearchRunner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLatestOnlySearchRunner", () => {
  it("runs one search at a time and retains only the newest pending request", async () => {
    const first = deferred();
    const last = deferred();
    const started: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;

    const execute = vi.fn(async (query: string) => {
      started.push(query);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await (query === "first" ? first.promise : last.promise);
      activeCount -= 1;
    });
    const runner = createLatestOnlySearchRunner(execute);

    const running = runner.submit("first");
    void runner.submit("superseded");
    void runner.submit("latest");

    expect(started).toEqual(["first"]);
    first.resolve();
    await vi.waitFor(() => expect(started).toEqual(["first", "latest"]));
    last.resolve();
    await running;

    expect(execute).toHaveBeenCalledTimes(2);
    expect(maxActiveCount).toBe(1);
  });

  it("drops pending work after disposal", async () => {
    const first = deferred();
    const execute = vi.fn(async () => first.promise);
    const runner = createLatestOnlySearchRunner(execute);

    const running = runner.submit("first");
    void runner.submit("pending");
    runner.dispose();
    first.resolve();
    await running;

    expect(execute).toHaveBeenCalledTimes(1);
    await runner.submit("after-dispose");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
