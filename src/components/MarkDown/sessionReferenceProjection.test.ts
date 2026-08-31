import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import { projectMarkdownSessionReferences } from "./sessionReferenceProjection";

const CLOUD_REFERENCE = buildCloudSessionReference({
  orgId: "org-1",
  ownerUserId: "owner-1",
  sourceSessionId: "session-1",
});

describe("projectMarkdownSessionReferences", () => {
  it("keeps ordinary Markdown references inline", () => {
    const source =
      "See [issue 760](https://github.com/orgii/app/issues/760) and [docs](https://example.com).";

    expect(projectMarkdownSessionReferences(source)).toEqual({
      text: source,
      references: [],
      referenceOnly: false,
    });
  });

  it("promotes a serialized local session pill into an attachment", () => {
    expect(
      projectMarkdownSessionReferences(
        "review Flaky-auth [session:session-1] before merging"
      )
    ).toEqual({
      text: "review before merging",
      references: [
        { kind: "local", sessionId: "session-1", title: "Flaky-auth" },
      ],
      referenceOnly: false,
    });
  });

  it("promotes bare and linked cloud session references and de-duplicates them", () => {
    const result = projectMarkdownSessionReferences(
      `Attached ${CLOUD_REFERENCE}. Again: [session](${CLOUD_REFERENCE})`
    );

    expect(result.text).toBe("Attached Again:");
    expect(result.references).toEqual([
      {
        kind: "cloud",
        reference: {
          version: 1,
          orgId: "org-1",
          ownerUserId: "owner-1",
          sourceSessionId: "session-1",
        },
      },
    ]);
  });

  it("classifies a session-only GitHub comment as an attachment entry", () => {
    expect(projectMarkdownSessionReferences(CLOUD_REFERENCE)).toMatchObject({
      text: "",
      referenceOnly: true,
    });
  });

  it("keeps session-looking examples inside code literal", () => {
    const source = [
      `\`${CLOUD_REFERENCE}\``,
      "`sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821`",
      "```text",
      "Triage [session:session-1]",
      "```",
    ].join("\n");

    expect(projectMarkdownSessionReferences(source)).toEqual({
      text: source,
      references: [],
      referenceOnly: false,
    });
  });

  it("supports Markdown session links from imported histories", () => {
    expect(
      projectMarkdownSessionReferences(
        "Continue [Previous session](session://sdeagent-abc/42)"
      )
    ).toEqual({
      text: "Continue",
      references: [
        {
          kind: "local",
          sessionId: "sdeagent-abc",
          title: "Previous session",
        },
      ],
      referenceOnly: false,
    });
  });

  it("promotes validated bare session ids into cards", () => {
    const sessionId = "sdeagent-ee970f47-dfcb-4a78-97e5-fc56e3451821";
    expect(
      projectMarkdownSessionReferences(`continue ${sessionId} next`)
    ).toEqual({
      text: "continue next",
      references: [{ kind: "local", sessionId, title: sessionId }],
      referenceOnly: false,
    });
  });

  it("promotes validated delegate session handles", () => {
    const sessionId =
      "agent-builtin:explore-93edacaf-c1e2-44bb-8e13-4bf5362aaecb";
    expect(projectMarkdownSessionReferences(sessionId)).toMatchObject({
      text: "",
      references: [{ kind: "local", sessionId, title: sessionId }],
      referenceOnly: true,
    });
  });

  it("bounds cards and leaves additional references visible in prose", () => {
    const source = [1, 2, 3, 4, 5]
      .map((index) => `S${index} [session:session-${index}]`)
      .join(" ");
    const result = projectMarkdownSessionReferences(source);

    expect(result.references).toHaveLength(4);
    expect(result.text).toBe("S5 [session:session-5]");
    expect(result.referenceOnly).toBe(false);
  });

  it("does not extract session ids embedded in longer job handles", () => {
    const source =
      "job extract-mem-sdeagent-9be175b5-aacb-4b2b-b23a-b46a8d4d6a35-ad0ba9f1-b874-4927-b2f9-03b936aa0aef ran";
    expect(projectMarkdownSessionReferences(source)).toEqual({
      text: source,
      references: [],
      referenceOnly: false,
    });
  });

  it("preserves offsets when emoji precede a session attachment", () => {
    expect(
      projectMarkdownSessionReferences(
        "👍 review Triage [session:session-1] next"
      )
    ).toMatchObject({
      text: "👍 review next",
      references: [{ kind: "local", sessionId: "session-1", title: "Triage" }],
    });
  });
});
