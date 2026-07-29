import { describe, expect, it } from "vitest";

import { VALID_MODELS_TABS } from "./integrationsPageConstants";

describe("integrations page deep-link constants", () => {
  it("keeps the semantic-model summary tab URL-backed", () => {
    expect(VALID_MODELS_TABS).toContain("embedding");
  });
});
