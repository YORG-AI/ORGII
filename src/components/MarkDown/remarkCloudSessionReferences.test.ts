import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import {
  remarkCloudSessionReferences,
  splitCloudSessionReferenceText,
} from "./remarkCloudSessionReferences";

const REFERENCE = buildCloudSessionReference({
  orgId: "0830d453-1111-4222-8333-444455556666",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "sdeagent-1784668132283",
});

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function paragraph(...children: Node[]): Node {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

function text(value: string): Node {
  return { type: "text", value };
}

function run(tree: Node): Node {
  remarkCloudSessionReferences()(tree);
  return tree;
}

describe("splitCloudSessionReferenceText", () => {
  it("returns null when the text carries no reference", () => {
    expect(splitCloudSessionReferenceText("no reference here")).toBeNull();
  });

  it("splits surrounding prose around the reference", () => {
    const parts = splitCloudSessionReferenceText(`see ${REFERENCE} for review`);
    expect(parts).toEqual([
      { type: "text", value: "see " },
      {
        type: "link",
        url: REFERENCE,
        children: [{ type: "text", value: REFERENCE }],
      },
      { type: "text", value: " for review" },
    ]);
  });

  it("strips sentence punctuation trailing the reference", () => {
    const parts = splitCloudSessionReferenceText(`context: ${REFERENCE}.`);
    expect(parts?.[1]).toMatchObject({ type: "link", url: REFERENCE });
    expect(parts?.[2]).toEqual({ type: "text", value: "." });
  });

  it("linkifies every reference in one text run", () => {
    const other = buildCloudSessionReference({
      orgId: "0830d453-1111-4222-8333-444455556666",
      ownerUserId: "394af2b7-bccd-4561-9fe0-df19d26538bd",
      sourceSessionId: "sdeagent-999",
    });
    const parts = splitCloudSessionReferenceText(`${REFERENCE} and ${other}`);
    expect(parts?.filter((part) => part.type === "link")).toHaveLength(2);
  });

  it("leaves malformed references as plain text", () => {
    const malformed = [
      "orgii://cloud/session/ref?v=2&org=a&owner=b&session=c",
      "orgii://cloud/session/ref?v=1&org=a&owner=b",
      "orgii://cloud/session?share=deadbeef",
      "orgii://cloud/session/ref?v=1&org=a&org=z&owner=b&session=c",
      "orgii://evil/session/ref?v=1&org=a&owner=b&session=c",
    ];
    for (const value of malformed) {
      expect(splitCloudSessionReferenceText(value)).toBeNull();
    }
  });

  it("matches the parser's case-insensitive scheme handling", () => {
    const upper = REFERENCE.replace("orgii://", "ORGII://");
    const parts = splitCloudSessionReferenceText(`ref ${upper}`);
    expect(parts?.[1]).toMatchObject({ type: "link", url: upper });
  });

  it("skips candidates longer than any legitimate reference", () => {
    const overlong = `${REFERENCE}${"x".repeat(600)}`;
    expect(splitCloudSessionReferenceText(overlong)).toBeNull();
  });

  it("stays linear on a whitespace-free run repeating the scheme", () => {
    // Guards the bounded scan: an unbounded one is O(n²) here, and this
    // shape (minified json, url lists) reaches the renderer from issue text.
    const blob = '{"a":"orgii://x","b":"orgii://y"},'.repeat(4000);
    const started = performance.now();
    expect(splitCloudSessionReferenceText(blob)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("keeps scanning after an invalid candidate", () => {
    const parts = splitCloudSessionReferenceText(
      `orgii://cloud/session/ref?v=9 then ${REFERENCE}`
    );
    expect(parts?.filter((part) => part.type === "link")).toEqual([
      {
        type: "link",
        url: REFERENCE,
        children: [{ type: "text", value: REFERENCE }],
      },
    ]);
  });
});

describe("remarkCloudSessionReferences", () => {
  it("rewrites a bare reference inside a paragraph", () => {
    const tree = run(paragraph(text(`review ${REFERENCE}`)));
    const children = tree.children?.[0].children ?? [];
    expect(children.map((child) => child.type)).toEqual(["text", "link"]);
    expect(children[1].url).toBe(REFERENCE);
  });

  it("does not descend into an existing link", () => {
    const link: Node = {
      type: "link",
      url: REFERENCE,
      children: [text(REFERENCE)],
    };
    run(paragraph(link));
    expect(link.children).toEqual([text(REFERENCE)]);
  });

  it("leaves inline code and fenced code untouched", () => {
    const inline: Node = { type: "inlineCode", value: REFERENCE };
    const fence: Node = { type: "code", value: `run ${REFERENCE}` };
    const tree: Node = { type: "root", children: [inline, fence] };
    run(tree);
    expect(tree.children).toEqual([inline, fence]);
    expect(inline.value).toBe(REFERENCE);
    expect(fence.value).toBe(`run ${REFERENCE}`);
  });

  it("rewrites references nested in list items and emphasis", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "emphasis", children: [text(REFERENCE)] }],
                },
              ],
            },
          ],
        },
      ],
    };
    run(tree);
    const emphasis =
      tree.children?.[0].children?.[0].children?.[0].children?.[0];
    expect(emphasis?.children?.[0]).toMatchObject({
      type: "link",
      url: REFERENCE,
    });
  });

  it("leaves a tree with no references structurally identical", () => {
    const tree = paragraph(text("nothing to see"));
    const before = JSON.stringify(tree);
    run(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });
});
