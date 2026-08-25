import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import { splitChannelMessageBody } from "./channelMessageBody";

const ISSUE_URL = "https://github.com/org2AI/ORG2/issues/443";
const CLOUD_REFERENCE = buildCloudSessionReference({
  orgId: "org-1",
  ownerUserId: "owner-1",
  sourceSessionId: "remote-session-1",
});

describe("splitChannelMessageBody", () => {
  it("leaves plain Markdown alone", () => {
    const body = "See [the docs](https://example.com/docs).";
    expect(splitChannelMessageBody(body)).toEqual({
      text: body,
      references: [],
    });
  });

  it("promotes local sessions to cards", () => {
    expect(
      splitChannelMessageBody("look at Triage [session:sess-1] before we cut")
    ).toEqual({
      text: "look at before we cut",
      references: [{ kind: "session", sessionId: "sess-1", title: "Triage" }],
    });
  });

  it("promotes canonical cloud sessions to cards", () => {
    expect(splitChannelMessageBody(`review ${CLOUD_REFERENCE}`)).toEqual({
      text: "review",
      references: [
        {
          kind: "cloudSession",
          reference: {
            version: 1,
            orgId: "org-1",
            ownerUserId: "owner-1",
            sourceSessionId: "remote-session-1",
          },
          title: undefined,
        },
      ],
    });
  });

  it("projects GitHub issue pills to ordinary Markdown links", () => {
    expect(
      splitChannelMessageBody(`org2AI/ORG2#443 [issue:${ISSUE_URL}]`)
    ).toEqual({
      text: `[org2AI/ORG2#443](${ISSUE_URL})`,
      references: [],
    });
  });

  it("projects work-item pills to ordinary Markdown links", () => {
    expect(
      splitChannelMessageBody(
        "AUTH-12 [workitem:workitem://auth/AUTH-12/1700000000000]"
      )
    ).toEqual({
      text: "[AUTH-12](workitem://auth/AUTH-12/1700000000000)",
      references: [],
    });
  });

  it("keeps bare web references inline", () => {
    expect(splitChannelMessageBody(`blocked on ${ISSUE_URL}.`)).toEqual({
      text: `blocked on ${ISSUE_URL}.`,
      references: [],
    });
  });

  it("keeps non-session references inline next to a session card", () => {
    expect(
      splitChannelMessageBody(
        `ship Triage [session:sess-1] with org2AI/ORG2#443 [issue:${ISSUE_URL}]`
      )
    ).toEqual({
      text: `ship with [org2AI/ORG2#443](${ISSUE_URL})`,
      references: [{ kind: "session", sessionId: "sess-1", title: "Triage" }],
    });
  });
});
