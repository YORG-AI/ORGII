import { extractArgsSummary, formatSearchQuerySubtitle } from "../argsSummary";
import { parseAgentMessageCard } from "../cardParsers";

describe("extractArgsSummary", () => {
  it("formats grep alternation patterns as a readable quoted list", () => {
    expect(
      formatSearchQuerySubtitle("call_id_index|tool_result|merge_events")
    ).toBe('"call_id_index, tool_result, merge_events"');
    expect(
      extractArgsSummary("code_search", {
        action: "grep",
        query: "call_id_index|tool_result|merge_events",
      })
    ).toBe('"call_id_index, tool_result, merge_events"');
  });

  it("shows camel-case file targets instead of a generic tool label", () => {
    expect(
      extractArgsSummary("Read", {
        targetFile: "/Users/vinceorz/Projects/ORGII/src/app/root.tsx",
      })
    ).toBe("/Users/vinceorz/Projects/ORGII/src/app/root.tsx");

    expect(
      extractArgsSummary("read_file", {
        filePath: "/Users/vinceorz/Projects/claude_code/README.md",
      })
    ).toBe("/Users/vinceorz/Projects/claude_code/README.md");
  });

  it("shows browser CLI command target without duplicating the parsed title", () => {
    expect(
      extractArgsSummary("control_browser_with_agent_browser", {
        command: "open https://example.com",
      })
    ).toBe("https://example.com");

    expect(
      extractArgsSummary("control_browser_with_playwright", {
        command: "snapshot",
      })
    ).toBe("snapshot");
  });

  it("shows browser CLI command target without duplicating the parsed action", () => {
    expect(
      extractArgsSummary("control_browser_with_agent_browser", {
        command: "click e20",
      })
    ).toBe("e20");
  });

  it("parses Agent Team message cards with member ids only", () => {
    const card = parseAgentMessageCard(
      {
        recipient_member_id: "planner",
        sender_member_id: "builder",
        kind: "plain",
        summary: "Ready for review",
      },
      {
        sender_member_id: "builder",
        delivered: [
          {
            inbox_id: 42,
            recipient_member_id: "planner",
          },
        ],
      }
    );

    expect(card.sender).toBe("builder");
    expect(card.recipient).toBe("planner");
    expect(card.recipientMemberId).toBe("planner");
    expect(card.senderMemberId).toBe("builder");
    expect(card.deliveries).toEqual([
      { inboxId: 42, recipientMemberId: "planner" },
    ]);
  });
});
