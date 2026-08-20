import { describe, expect, it } from "vitest";

import {
  parseGroupChatRoute,
  resolveGroupChatOutgoing,
} from "./groupChatRouting";

const members = [
  { memberId: "coord", name: "Lead", isCoordinator: true },
  { memberId: "alice", name: "Alice", isCoordinator: false },
] as const;

describe("parseGroupChatRoute", () => {
  it("routes @mentions and strips the mention header from the body", () => {
    const route = parseGroupChatRoute("@Alice please review", members);
    expect(route.targetMemberId).toBe("alice");
    expect(route.body).toBe("please review");
    expect(route.displayText).toBe("@Alice please review");
  });

  it("routes unmentioned text to the coordinator", () => {
    const route = parseGroupChatRoute("hello team", members);
    expect(route.targetMemberId).toBeNull();
    expect(route.body).toBe("hello team");
  });

  it("throws for unknown mentions", () => {
    expect(() => parseGroupChatRoute("@Nobody hi", members)).toThrow(
      "Unknown Agent Team mention"
    );
  });
});

describe("resolveGroupChatOutgoing", () => {
  it("uses the display body when no agent projection exists", () => {
    const outgoing = resolveGroupChatOutgoing(
      { displayText: "@Alice please review" },
      members
    );
    expect(outgoing.targetMemberId).toBe("alice");
    expect(outgoing.agentBody).toBe("please review");
  });

  it("strips the same mention header from an agent projection that still routes identically", () => {
    const outgoing = resolveGroupChatOutgoing(
      {
        displayText: "@Alice statusline [skill:/statusline] please",
        agentContent: "@Alice /statusline please",
      },
      members
    );
    expect(outgoing.targetMemberId).toBe("alice");
    // Display side keeps the pill serialization…
    expect(outgoing.displayText).toBe(
      "@Alice statusline [skill:/statusline] please"
    );
    // …the member inbox receives the projected body without the header.
    expect(outgoing.agentBody).toBe("/statusline please");
  });

  it("sends a rewritten agent projection (canvas contract) whole", () => {
    const contract =
      "[Canvas Creation Request]\nCreate a new interactive inline Canvas for the user request below. Call render_inline_canvas exactly once for the finished Canvas.\n\n[User Request]\nbuild a timer";
    const outgoing = resolveGroupChatOutgoing(
      {
        displayText: "@Alice canvas [skill:/canvas] build a timer",
        agentContent: contract,
      },
      members
    );
    expect(outgoing.targetMemberId).toBe("alice");
    expect(outgoing.displayText).toBe(
      "@Alice canvas [skill:/canvas] build a timer"
    );
    expect(outgoing.agentBody).toBe(contract);
  });

  it("routes on the display text even when the agent copy could not parse", () => {
    const outgoing = resolveGroupChatOutgoing(
      {
        displayText: "@Alice go",
        agentContent: "@UnknownMember go",
      },
      members
    );
    expect(outgoing.targetMemberId).toBe("alice");
    expect(outgoing.agentBody).toBe("@UnknownMember go");
  });
});
