/**
 * Linkify bare ORG2 Cloud session references in markdown text.
 *
 * A reference pasted into a GitHub issue body, PR description, or chat
 * message arrives as plain text: `orgii://` is not an autolink protocol in
 * GFM, and GitHub's own sanitizer strips the scheme, so the reference stays
 * opaque text everywhere outside this app. This plugin gives it back its
 * meaning in-app by rewriting each VALID reference into a link node, which
 * the renderer's `a` component turns into an ordinary Markdown link.
 *
 * Only `text` nodes are rewritten, so references inside code spans and code
 * fences (separate node types) stay literal, and link-bearing parents are
 * skipped so an explicit `[label](orgii://…)` or `<orgii://…>` autolink —
 * both already link nodes upstream — is never double-wrapped.
 *
 * Candidate detection and validation live in `scanCloudSessionReferences`,
 * shared with the session-attachment projection. The scanner fails closed:
 * anything malformed stays plain text rather than becoming a link that
 * resolves to nothing.
 */
import { scanCloudSessionReferences } from "@src/features/Org2Cloud/cloudSessionReference";

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/** Parents whose text must not be re-linkified; links cannot nest. */
const LINK_BEARING_PARENTS = new Set([
  "link",
  "linkReference",
  "definition",
  "image",
  "imageReference",
]);

/**
 * Split one text value into alternating text/link nodes, or null when it
 * carries no valid reference (the caller then keeps the original node).
 */
export function splitCloudSessionReferenceText(
  value: string
): MdastNode[] | null {
  const spans = scanCloudSessionReferences(value);
  if (spans.length === 0) return null;

  const nodes: MdastNode[] = [];
  let consumed = 0;
  for (const span of spans) {
    if (span.start > consumed) {
      nodes.push({ type: "text", value: value.slice(consumed, span.start) });
    }
    nodes.push({
      type: "link",
      url: span.url,
      children: [{ type: "text", value: span.url }],
    });
    consumed = span.end;
  }
  if (consumed < value.length) {
    nodes.push({ type: "text", value: value.slice(consumed) });
  }
  return nodes;
}

function transformChildren(node: MdastNode): void {
  const children = node.children;
  if (!children || LINK_BEARING_PARENTS.has(node.type)) return;

  const next: MdastNode[] = [];
  let rewritten = false;
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replacement = splitCloudSessionReferenceText(child.value);
      if (replacement) {
        next.push(...replacement);
        rewritten = true;
        continue;
      }
      next.push(child);
      continue;
    }
    transformChildren(child);
    next.push(child);
  }
  if (rewritten) node.children = next;
}

export function remarkCloudSessionReferences() {
  return (tree: MdastNode): void => {
    transformChildren(tree);
  };
}
