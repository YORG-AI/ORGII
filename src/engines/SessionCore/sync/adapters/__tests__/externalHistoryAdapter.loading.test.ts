import { describe, expect, it } from "vitest";

import { cliAdapter } from "../cliAdapter";
import { externalHistoryAdapter } from "../externalHistoryAdapter";

describe("external history loading boundary", () => {
  it("does not expose the superseded renderer full-history loader", () => {
    expect(externalHistoryAdapter.historyMode).toBe("bounded-replay");
    expect(externalHistoryAdapter).not.toHaveProperty("loadHistory");
  });

  it("uses the same bounded history mode for managed external CLIs", () => {
    expect(cliAdapter.historyMode).toBe("bounded-replay");
    expect(cliAdapter).not.toHaveProperty("loadHistory");
  });
});
