import { describe, expect, it } from "vitest";

import { observeSharedOperation } from "../sharedOperation";

describe("observeSharedOperation", () => {
  it("cancels one observer without cancelling equivalent consumers", async () => {
    let finish: ((value: string) => void) | undefined;
    const shared = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const cancelled = observeSharedOperation(shared, controller.signal);
    const active = observeSharedOperation(shared);

    controller.abort();
    finish?.("created");

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(active).resolves.toBe("created");
  });

  it("rejects immediately when the caller is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      observeSharedOperation(Promise.resolve("unused"), controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
