/**
 * Integration guard for the three pieces that must agree for a reference in
 * issue text to reach the chip: the remark plugin (bare text becomes a
 * link), the url transform (the `orgii:` href survives sanitization), and
 * react-markdown's own link routing. Each is unit-tested alone; this proves
 * they compose inside the real pipeline, next to remark-gfm.
 *
 * The `a` component is stubbed so the assertion stays on the href that
 * reaches it — the chip itself needs router and store context that only the
 * running app provides. Written with `createElement` because the suite
 * collects `*.test.ts` only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

import { markdownUrlTransform } from "./markdownUrlTransform";
import { remarkCloudSessionReferences } from "./remarkCloudSessionReferences";

const REFERENCE = buildCloudSessionReference({
  orgId: "0830d453-1111-4222-8333-444455556666",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "sdeagent-1784668132283",
});

const ESCAPED_REFERENCE = REFERENCE.replace(/&/gu, "&amp;");

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkCloudSessionReferences],
        urlTransform: markdownUrlTransform,
        components: {
          a: ({ href }: { href?: string }) =>
            createElement("b", { "data-ref": href ?? "" }, "chip"),
        },
      },
      markdown
    )
  );
}

describe("cloud session reference rendering pipeline", () => {
  it("routes a bare reference in prose to the link component, href intact", () => {
    const html = render(`Please review ${REFERENCE} before merging.`);
    expect(html).toContain(`data-ref="${ESCAPED_REFERENCE}"`);
    expect(html).toContain("Please review");
    expect(html).toContain("before merging.");
  });

  it("routes the explicit markdown link form the same way", () => {
    expect(render(`[review this](${REFERENCE})`)).toContain(
      `data-ref="${ESCAPED_REFERENCE}"`
    );
  });

  it("routes the angle-bracket autolink form the same way", () => {
    expect(render(`see <${REFERENCE}>`)).toContain(
      `data-ref="${ESCAPED_REFERENCE}"`
    );
  });

  it("leaves a reference inside a code span as literal text", () => {
    const html = render(`\`${REFERENCE}\``);
    expect(html).not.toContain("data-ref");
    expect(html).toContain("<code>");
  });

  it("leaves a reference inside a fenced block as literal text", () => {
    expect(render(`\`\`\`\n${REFERENCE}\n\`\`\``)).not.toContain("data-ref");
  });

  it("still sanitizes a dangerous href to an empty link", () => {
    expect(render("[click](javascript:alert(1))")).toContain('data-ref=""');
  });

  it("leaves ordinary autolinked urls untouched", () => {
    expect(render("https://github.com/org2AI/ORG2")).toContain(
      'data-ref="https://github.com/org2AI/ORG2"'
    );
  });

  it("linkifies a reference inside a gfm table cell", () => {
    const html = render(`| session |\n| --- |\n| ${REFERENCE} |`);
    expect(html).toContain("<table>");
    expect(html).toContain(`data-ref="${ESCAPED_REFERENCE}"`);
  });
});
