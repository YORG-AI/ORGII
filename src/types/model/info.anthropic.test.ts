import { getModelInfo } from "./info";

describe("Anthropic model info", () => {
  it("uses Fable 5.1 output limits before the generic Fable fallback", () => {
    for (const model of [
      "claude-fable-5-1",
      "claude-fable-5-1-max",
      "anthropic/claude-fable-5-1-xhigh",
    ]) {
      expect(getModelInfo(model)).toMatchObject({
        providerKey: "anthropic",
        contextWindow: 1000,
        maxOutput: 128,
        vision: true,
        reasoning: true,
      });
    }
    expect(getModelInfo("claude-fable-5")?.maxOutput).toBe(32);
  });
});
