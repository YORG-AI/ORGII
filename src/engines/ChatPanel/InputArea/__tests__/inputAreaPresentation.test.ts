import { describe, expect, it } from "vitest";

import { isContextualInputAreaPresentation } from "../inputAreaPresentation";

describe("isContextualInputAreaPresentation", () => {
  it("only classifies contextual composers as contextual", () => {
    expect(isContextualInputAreaPresentation("default")).toBe(false);
    expect(isContextualInputAreaPresentation("contextual")).toBe(true);
  });
});
