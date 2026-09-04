import { describe, expect, it } from "vitest";

import { projectPortableAgentMessageText } from "../projectPortableAgentMessageText";

describe("projectPortableAgentMessageText", () => {
  it("strips inline think tags like desktop ChatSession", () => {
    expect(
      projectPortableAgentMessageText("before<think>hidden</think>after")
    ).toBe("beforeafter");
  });

  it("removes trailing protocol placeholders after writing-block projection", () => {
    expect(
      projectPortableAgentMessageText(
        ["Visible answer", "", "[REDACTED]"].join("\n")
      )
    ).toBe("Visible answer");
  });

  it("drops status writing blocks that only carry redacted placeholders", () => {
    expect(
      projectPortableAgentMessageText(
        [
          "是的，我运行在 Cursor 里。",
          "",
          ':::writing{variant="status" id="step-1"}',
          "[REDACTED]",
          ":::",
        ].join("\n")
      )
    ).toBe("是的，我运行在 Cursor 里。");
  });
});
