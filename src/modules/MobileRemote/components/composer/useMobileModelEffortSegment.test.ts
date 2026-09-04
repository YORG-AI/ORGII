// @vitest-environment node
import { describe, expect, it } from "vitest";

import { KEY_SOURCE } from "@src/api/tauri/session";
import type { MobileSessionModelConfig } from "@src/modules/MobileRemote/connection/types";

import { toMobileLastModelSelection } from "./useMobileModelEffortSegment";

describe("toMobileLastModelSelection", () => {
  it("maps own-key sessions to LastModelSelection", () => {
    const config: MobileSessionModelConfig = {
      sessionId: "s1",
      model: "claude-sonnet-4-5",
      accountId: "acct-1",
      keySource: KEY_SOURCE.OWN,
      modelEditable: true,
    };
    expect(toMobileLastModelSelection(config)).toEqual({
      keySource: KEY_SOURCE.OWN,
      model: "claude-sonnet-4-5",
      selectedAccountId: "acct-1",
      cliAgentType: undefined,
    });
  });

  it("maps hosted sessions to listing model fields", () => {
    const config: MobileSessionModelConfig = {
      sessionId: "s1",
      model: "gpt-5.6-sol-max",
      keySource: KEY_SOURCE.HOSTED,
      modelEditable: true,
    };
    expect(toMobileLastModelSelection(config)).toEqual({
      keySource: KEY_SOURCE.HOSTED,
      listingModel: "gpt-5.6-sol-max",
      cliAgentType: undefined,
    });
  });
});
