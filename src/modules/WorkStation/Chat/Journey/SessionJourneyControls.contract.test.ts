import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(__dirname, "SessionJourneyControls.tsx"),
  "utf8"
);

describe("SessionJourneyControls interaction contract", () => {
  it("wires both task start modes and exact checkpoint/fork anchors", () => {
    expect(source).toContain('"最近用户消息"');
    expect(source).toContain('"下一条用户消息"');
    expect(source).toContain("sessionJourneyApi.startTask");
    expect(source).toContain("sessionJourneyApi.checkpoint");
    expect(source).toContain("sessionJourneyApi.startFork");
    expect(source).toContain("anchorMessageId: messageId");
    expect(source).toContain("messageId,");
  });
  it("wires finish, conflict reload and recovery without opening Workstation", () => {
    expect(source).toContain("sessionJourneyApi.finishTask");
    expect(source).toContain("isRevisionConflict(reason)");
    expect(source).toContain("await reload()");
    expect(source).toContain("恢复会话旅程");
    expect(source).not.toContain("openFileInWorkStation");
    expect(source).not.toContain("chatPanelMaximizedAtom");
  });
  it("keeps review dock float hide reopen, explicit discard and shared compare", () => {
    expect(source).toContain('setMode("dock")');
    expect(source).toContain('mode === "dock" ? "float" : "dock"');
    expect(source).toContain('onMode("hidden")');
    expect(source).toContain("sessionJourneyApi.discard");
    expect(source).toContain("sessionJourneyApi.forkCompare(sessionId)");
  });
});
