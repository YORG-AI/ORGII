import { describe, expect, it } from "vitest";

import {
  INITIAL_TASK_RENDER_COUNT,
  TASK_RENDER_BATCH_SIZE,
  getNextTaskRenderCount,
} from "./taskRenderWindow";

describe("Kanban column task render window", () => {
  it("starts and grows in batches of 25", () => {
    expect(INITIAL_TASK_RENDER_COUNT).toBe(25);
    expect(TASK_RENDER_BATCH_SIZE).toBe(25);
    expect(getNextTaskRenderCount(INITIAL_TASK_RENDER_COUNT, 100)).toBe(50);
    expect(getNextTaskRenderCount(50, 100)).toBe(75);
  });

  it("clamps the final batch to the column length", () => {
    expect(getNextTaskRenderCount(25, 37)).toBe(37);
    expect(getNextTaskRenderCount(37, 37)).toBe(37);
  });
});
