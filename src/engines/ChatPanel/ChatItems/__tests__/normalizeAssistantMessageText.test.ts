import { describe, expect, it } from "vitest";

import { normalizeAssistantMessageText } from "../normalizeAssistantMessageText";

describe("normalizeAssistantMessageText", () => {
  it("unwraps writing blocks into ordinary Markdown", () => {
    expect(
      normalizeAssistantMessageText(
        [
          "Intro",
          "",
          ':::writing{variant="chat_message" id="48317"}',
          "**Important** answer",
          ":::",
        ].join("\n")
      )
    ).toBe(["Intro", "", "**Important** answer"].join("\n"));
  });

  it("projects writing-block tone alternatives as Markdown headings", () => {
    expect(
      normalizeAssistantMessageText(
        [
          ':::writing{variant="chat_message" id="48318"}',
          "---tone concise",
          "Short answer",
          "---tone detailed",
          "Long answer",
          ":::",
        ].join("\n")
      )
    ).toBe(
      ["#### concise", "Short answer", "#### detailed", "Long answer"].join(
        "\n"
      )
    );
  });

  it("keeps partial writing content readable while streaming", () => {
    expect(
      normalizeAssistantMessageText(
        ':::writing{variant="standard" id="48319"}\nStreaming body'
      )
    ).toBe("Streaming body");
  });

  it("does not rewrite unrelated Markdown directives or ordinary prose", () => {
    const directive = ":::note\nKeep this directive\n:::";
    expect(normalizeAssistantMessageText(directive)).toBe(directive);
    expect(normalizeAssistantMessageText("Ordinary response")).toBe(
      "Ordinary response"
    );
  });

  it("drops non-portable writing blocks such as status placeholders", () => {
    expect(
      normalizeAssistantMessageText(
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
