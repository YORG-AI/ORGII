import { describe, expect, it } from "vitest";

import { resolveForkModelPreselection } from "./modelPreselection";

describe("resolveForkModelPreselection", () => {
  it("prefers the source session's model over the fallback agent's model", () => {
    // External-history fork: no agent hint, no user agent pick — the
    // imported conversation ran on gpt-5.2-codex, so that must win even
    // though the default sde agent is configured with a Claude model.
    expect(
      resolveForkModelPreselection({
        chosenModel: "",
        agentChoiceExplicit: false,
        preferredAgentModel: "claude-opus-5",
        sourceModelOnAccount: "gpt-5.2-codex",
        fallbackModel: "first-alphabetical",
      })
    ).toBe("gpt-5.2-codex");
  });

  it("keeps the agent's configured model when the agent was explicitly chosen", () => {
    expect(
      resolveForkModelPreselection({
        chosenModel: "",
        agentChoiceExplicit: true,
        preferredAgentModel: "claude-opus-5",
        sourceModelOnAccount: "gpt-5.2-codex",
        fallbackModel: "first-alphabetical",
      })
    ).toBe("claude-opus-5");
  });

  it("always honors an explicit user model pick", () => {
    expect(
      resolveForkModelPreselection({
        chosenModel: "claude-haiku-4-5",
        agentChoiceExplicit: false,
        preferredAgentModel: "claude-opus-5",
        sourceModelOnAccount: "gpt-5.2-codex",
        fallbackModel: "first-alphabetical",
      })
    ).toBe("claude-haiku-4-5");
  });

  it("falls back agent-model → first option when the account lacks the source model", () => {
    expect(
      resolveForkModelPreselection({
        chosenModel: "",
        agentChoiceExplicit: false,
        preferredAgentModel: "claude-opus-5",
        sourceModelOnAccount: undefined,
        fallbackModel: "first-alphabetical",
      })
    ).toBe("claude-opus-5");
    expect(
      resolveForkModelPreselection({
        chosenModel: "",
        agentChoiceExplicit: false,
        preferredAgentModel: undefined,
        sourceModelOnAccount: undefined,
        fallbackModel: "first-alphabetical",
      })
    ).toBe("first-alphabetical");
  });
});
