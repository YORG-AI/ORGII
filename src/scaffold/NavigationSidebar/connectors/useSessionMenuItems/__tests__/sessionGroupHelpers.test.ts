import { describe, expect, it } from "vitest";

import {
  SESSION_GROUP_LABELS,
  getSessionGroupKey,
} from "@src/config/sessionAgentGroups";

import { groupKeyToWireCategory } from "../sessionGroupHelpers";

describe("groupKeyToWireCategory", () => {
  it("keeps imported history load-more categories source-specific", () => {
    expect(groupKeyToWireCategory("external_history:cursor_ide")).toBe(
      "external_history:cursor_ide"
    );
    expect(groupKeyToWireCategory("external_history:codex_app")).toBe(
      "external_history:codex_app"
    );
    expect(groupKeyToWireCategory("external_history:claude_code")).toBe(
      "external_history:claude_code"
    );
    expect(groupKeyToWireCategory("external_history:opencode")).toBe(
      "external_history:opencode"
    );
    expect(groupKeyToWireCategory("external_history:windsurf")).toBe(
      "external_history:windsurf"
    );
  });

  it("maps existing non-imported groups to their loader categories", () => {
    expect(groupKeyToWireCategory("cli")).toBe("cli_agent");
    expect(groupKeyToWireCategory("human")).toBe("human_session");
    expect(groupKeyToWireCategory("os")).toBe("os_agent");
    expect(groupKeyToWireCategory("sde")).toBe("standalone_agent");
    expect(groupKeyToWireCategory("wingman")).toBe("standalone_agent");
  });

  it("keeps Human sessions in the Work Logs sidebar group", () => {
    expect(getSessionGroupKey("humansession-1")).toBe("human");
    expect(SESSION_GROUP_LABELS.human).toBe("Work Logs");
  });
});
