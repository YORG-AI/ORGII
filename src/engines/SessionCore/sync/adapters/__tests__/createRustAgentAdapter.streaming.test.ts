import { describe, expect, it, vi } from "vitest";

import { createStreamingEdgeController } from "../createRustAgentAdapter";

describe("Rust Agent streaming edge controller", () => {
  it("coalesces 1,000 deltas into one true and one terminal false write", () => {
    const write = vi.fn();
    const controller = createStreamingEdgeController(write);

    for (let index = 0; index < 1_000; index += 1) {
      controller.set(true);
    }
    controller.set(false);
    controller.set(false);
    controller.set(false);

    expect(write.mock.calls).toEqual([[true], [false]]);
    expect(controller.value).toBe(false);
  });

  it("forces an unknown owner to converge to false only once", () => {
    const write = vi.fn();
    const controller = createStreamingEdgeController(write);

    controller.set(false);
    controller.set(false);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(false);
  });
});
