import { describe, expect, it } from "vitest";

import {
  parseModelSlashCommand,
  resolveModelSlashTarget,
} from "../useSubmitMessage";

describe("useSubmitMessage slash helpers", () => {
  it("解析 /model 参数并忽略裸 /model", () => {
    expect(parseModelSlashCommand(" /model sonnet ")).toBe("sonnet");
    expect(parseModelSlashCommand("/model")).toBeNull();
  });

  it("按精确优先、片段其次解析模型别名", () => {
    const models = ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5"];
    expect(resolveModelSlashTarget("OPENAI/GPT-5.5", models)).toBe(
      "openai/gpt-5.5"
    );
    expect(resolveModelSlashTarget("sonnet", models)).toBe(
      "anthropic/claude-sonnet-4.6"
    );
    expect(resolveModelSlashTarget("unknown", models)).toBe("unknown");
  });
});
