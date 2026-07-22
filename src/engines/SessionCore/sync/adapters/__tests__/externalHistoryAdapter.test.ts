import { describe, expect, it } from "vitest";

import { cliAdapter } from "../cliAdapter";
import { externalHistoryAdapter } from "../externalHistoryAdapter";

describe("bounded replay adapter contracts", () => {
  it("does not expose a full-history loader for imported history", () => {
    expect(externalHistoryAdapter.historyMode).toBe("bounded-replay");
    expect("loadHistory" in externalHistoryAdapter).toBe(false);
  });

  it("routes every managed CLI through the same bounded transport", () => {
    expect(cliAdapter.historyMode).toBe("bounded-replay");
    expect("loadHistory" in cliAdapter).toBe(false);
  });
});
