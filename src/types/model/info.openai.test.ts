import { getModelInfo } from "./info";

describe("OpenAI model info", () => {
  it("uses Astra capabilities instead of the generic GPT fallback", () => {
    for (const model of [
      "gpt-6-astra",
      "gpt-6-astra-ultra-fast",
      "openai/gpt-6-astra-high",
    ]) {
      expect(getModelInfo(model)).toMatchObject({
        providerKey: "openai",
        contextWindow: 1050,
        maxOutput: 128,
        vision: true,
        reasoning: true,
      });
    }
    expect(getModelInfo("gpt-4o")?.contextWindow).toBe(128);
  });
});
