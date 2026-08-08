// @vitest-environment jsdom
//
// The read-side contract for a posted channel body: which parts of it become
// cards, which stay in the prose, and what the prose reads like once the cards
// have been lifted out of it.
import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import {
  type ChannelMessageReference,
  splitChannelMessageBody,
} from "./channelMessageBody";

const PR_URL = "https://github.com/org2AI/ORG2/pull/606";
const ISSUE_URL = "https://github.com/org2AI/ORG2/issues/443";
const WORK_ITEM_PILL = "[workitem:workitem://auth/AUTH-12/1700000000000]";
const CLOUD_SESSION_REFERENCE = buildCloudSessionReference({
  orgId: "org-1",
  ownerUserId: "owner-1",
  sourceSessionId: "remote-session-1",
});

function kinds(references: ChannelMessageReference[]): string[] {
  return references.map((reference) => reference.kind);
}

describe("splitChannelMessageBody", () => {
  it("leaves a body with no references alone", () => {
    expect(splitChannelMessageBody("rebasing onto hotfix")).toEqual({
      text: "rebasing onto hotfix",
      references: [],
    });
  });

  describe("session references", () => {
    it("lifts a session pill and closes the gap in the prose", () => {
      const { text, references } = splitChannelMessageBody(
        "look at Triage [session:sess-1] before we cut"
      );

      expect(text).toBe("look at before we cut");
      expect(references).toEqual([
        { kind: "session", sessionId: "sess-1", title: "Triage" },
      ]);
    });

    it("lifts a canonical cloud session without truncating its identity", () => {
      const { text, references } = splitChannelMessageBody(
        `review ${CLOUD_SESSION_REFERENCE} before standup`
      );

      expect(text).toBe("review before standup");
      expect(references).toEqual([
        {
          kind: "cloudSession",
          reference: {
            version: 1,
            orgId: "org-1",
            ownerUserId: "owner-1",
            sourceSessionId: "remote-session-1",
          },
        },
      ]);
    });

    it("recovers cloud references serialized by the old local-pill path", () => {
      const { text, references } = splitChannelMessageBody(
        `Remote-review [session:${CLOUD_SESSION_REFERENCE}]`
      );

      expect(text).toBe("");
      expect(references).toEqual([
        {
          kind: "cloudSession",
          reference: expect.objectContaining({
            orgId: "org-1",
            ownerUserId: "owner-1",
            sourceSessionId: "remote-session-1",
          }),
          title: "Remote-review",
        },
      ]);
    });

    it("de-duplicates canonical and legacy forms of one cloud session", () => {
      const { references } = splitChannelMessageBody(
        `${CLOUD_SESSION_REFERENCE} and Remote [session:${CLOUD_SESSION_REFERENCE}]`
      );

      expect(references).toHaveLength(1);
      expect(references[0]?.kind).toBe("cloudSession");
    });
  });

  describe("work item references", () => {
    it("lifts a work item pill with its project and short id", () => {
      const { text, references } = splitChannelMessageBody(
        `AUTH-12 ${WORK_ITEM_PILL}`
      );

      expect(text).toBe("");
      expect(references).toEqual([
        {
          kind: "workItem",
          projectSlug: "auth",
          shortId: "AUTH-12",
          title: "AUTH-12",
        },
      ]);
    });

    it("keeps the prose when the pill sits mid-sentence", () => {
      const { text, references } = splitChannelMessageBody(
        `ship AUTH-12 ${WORK_ITEM_PILL} today`
      );

      expect(text).toBe("ship today");
      expect(references).toEqual([
        {
          kind: "workItem",
          projectSlug: "auth",
          shortId: "AUTH-12",
          title: "AUTH-12",
        },
      ]);
    });

    it("ignores the base64 payload appended to a context pill", () => {
      const { references } = splitChannelMessageBody(
        "AUTH-12 [workitem:workitem://auth/AUTH-12/1700000000000::ZW5jb2RlZA==]"
      );

      expect(references).toEqual([
        {
          kind: "workItem",
          projectSlug: "auth",
          shortId: "AUTH-12",
          title: "AUTH-12",
        },
      ]);
    });

    it("de-duplicates two pills naming one item", () => {
      const { references } = splitChannelMessageBody(
        `AUTH-12 ${WORK_ITEM_PILL} and again AUTH-12 [workitem:workitem://auth/AUTH-12/1800000000000]`
      );

      expect(references).toHaveLength(1);
    });
  });

  describe("GitHub pills", () => {
    it("lifts a pull-request pill and drops the stranded label head", () => {
      const { text, references } = splitChannelMessageBody(
        `org2AI/ORG2#606 [pr:${PR_URL}]`
      );

      expect(text).toBe("");
      expect(references).toEqual([
        {
          kind: "github",
          url: PR_URL,
          displayName: "org2AI/ORG2#606",
          resource: "pr",
        },
      ]);
    });

    it("lifts an issue pill", () => {
      const { references } = splitChannelMessageBody(
        `org2AI/ORG2#443 [issue:${ISSUE_URL}]`
      );

      expect(references).toEqual([
        {
          kind: "github",
          url: ISSUE_URL,
          displayName: "org2AI/ORG2#443",
          resource: "issue",
        },
      ]);
    });

    it("lifts a generic link pill that happens to name an issue", () => {
      const { references } = splitChannelMessageBody(
        `see this [link:${ISSUE_URL}]`
      );

      expect(references).toEqual([
        {
          kind: "github",
          url: ISSUE_URL,
          displayName: "org2AI/ORG2#443",
          resource: "issue",
        },
      ]);
    });

    it("keeps prose that only looks like a stranded label", () => {
      const { text } = splitChannelMessageBody(`see [pr:${PR_URL}]`);

      expect(text).toBe("see");
    });
  });

  describe("bare GitHub URLs in prose", () => {
    it("lifts a typed pull-request URL", () => {
      const { text, references } = splitChannelMessageBody(
        `merging ${PR_URL} after lunch`
      );

      expect(text).toBe("merging after lunch");
      expect(references).toEqual([
        {
          kind: "github",
          url: PR_URL,
          displayName: "org2AI/ORG2#606",
          resource: "pr",
        },
      ]);
    });

    it("lifts a typed issue URL", () => {
      const { text, references } = splitChannelMessageBody(
        `still blocked on ${ISSUE_URL}`
      );

      expect(text).toBe("still blocked on");
      expect(references).toEqual([
        {
          kind: "github",
          url: ISSUE_URL,
          displayName: "org2AI/ORG2#443",
          resource: "issue",
        },
      ]);
    });

    it("takes the URL's trailing sentence punctuation with it", () => {
      const { text } = splitChannelMessageBody(`shipped in ${PR_URL}.`);

      expect(text).toBe("shipped in");
    });

    it("lifts several URLs from one message", () => {
      const { references } = splitChannelMessageBody(
        `${PR_URL} closes ${ISSUE_URL}`
      );

      expect(references).toHaveLength(2);
      expect(kinds(references)).toEqual(["github", "github"]);
    });

    it("renders one card when a pill and a bare URL name the same issue", () => {
      const { references } = splitChannelMessageBody(
        `org2AI/ORG2#443 [issue:${ISSUE_URL}] — see also ${ISSUE_URL}`
      );

      expect(references).toHaveLength(1);
    });

    it("renders one card when the same URL is typed twice", () => {
      const { references } = splitChannelMessageBody(
        `${ISSUE_URL} and again ${ISSUE_URL}`
      );

      expect(references).toHaveLength(1);
    });

    it("leaves a repository root as ordinary text", () => {
      const body = "the repo is https://github.com/org2AI/ORG2 by the way";
      const { text, references } = splitChannelMessageBody(body);

      expect(text).toBe(body);
      expect(references).toEqual([]);
    });

    it("leaves GitHub URLs it cannot render as ordinary text", () => {
      for (const url of [
        "https://github.com/org2AI/ORG2/commit/abc123",
        "https://github.com/org2AI",
        "https://github.com/org2AI/ORG2/blob/main/README.md",
        "https://example.com/org2AI/ORG2/pull/606",
      ]) {
        const { text, references } = splitChannelMessageBody(`see ${url}`);
        expect(references).toEqual([]);
        expect(text).toBe(`see ${url}`);
      }
    });

    it("leaves a markdown link's target and label intact", () => {
      const body = `see [the PR](${PR_URL}) and [${ISSUE_URL}](${ISSUE_URL})`;
      const { text, references } = splitChannelMessageBody(body);

      expect(references).toEqual([]);
      expect(text).toBe(body);
    });

    it("leaves a markdown autolink intact", () => {
      const body = `see <${PR_URL}>`;
      const { text, references } = splitChannelMessageBody(body);

      expect(references).toEqual([]);
      expect(text).toBe(body);
    });

    it("does not reach inside a pill it left in the prose", () => {
      const repoUrl = "https://github.com/org2AI/ORG2";
      const { text, references } = splitChannelMessageBody(
        `ORG2 [repo:${repoUrl}]`
      );

      expect(references).toEqual([]);
      expect(text).toBe(`ORG2 [repo:${repoUrl}]`);
    });
  });

  describe("mixed bodies", () => {
    it("lifts sessions, work items and GitHub references together", () => {
      const { text, references } = splitChannelMessageBody(
        `landed Triage [session:sess-1] for AUTH-12 ${WORK_ITEM_PILL} via ${PR_URL}`
      );

      expect(text).toBe("landed for via");
      expect(kinds(references)).toEqual(["session", "workItem", "github"]);
    });

    it("preserves card order across GitHub and cloud URLs", () => {
      const { references } = splitChannelMessageBody(
        `${PR_URL} then ${CLOUD_SESSION_REFERENCE}`
      );

      expect(kinds(references)).toEqual(["github", "cloudSession"]);
    });

    it("keeps unrelated pills inline for the read-only composer", () => {
      const { text, references } = splitChannelMessageBody(
        `config.ts [file:/repo/config.ts] and Triage [session:sess-1]`
      );

      expect(text).toBe("config.ts [file:/repo/config.ts] and");
      expect(kinds(references)).toEqual(["session"]);
    });
  });
});
