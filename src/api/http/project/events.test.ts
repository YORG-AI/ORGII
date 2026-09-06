import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  notifyProjectRosterChanged,
  notifyProjectStatusDefinitionsChanged,
} from "./events";

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));

describe("project best-effort notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not throw or reject when the event transport fails", async () => {
    mocks.emit.mockRejectedValueOnce(new Error("offline"));
    expect(() =>
      notifyProjectRosterChanged({ source: "members" })
    ).not.toThrow();
    await Promise.resolve();

    mocks.emit.mockImplementationOnce(() => {
      throw new Error("closed");
    });
    expect(() => notifyProjectStatusDefinitionsChanged("org-1")).not.toThrow();
  });
});
