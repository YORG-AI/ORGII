/**
 * Linkify bare ORG2 Cloud session references in markdown text.
 *
 * A reference pasted into a GitHub issue body, PR description, or chat
 * message arrives as plain text: `orgii://` is not an autolink protocol in
 * GFM, and GitHub's own sanitizer strips the scheme, so the reference stays
 * opaque text everywhere outside this app. This plugin gives it back its
 * meaning in-app by rewriting each VALID reference into a link node, which
 * the renderer's `a` component turns into a chip.
 *
 * Only `text` nodes are rewritten, so references inside code spans and code
 * fences (separate node types) stay literal, and link-bearing parents are
 * skipped so an explicit `[label](orgii://…)` or `<orgii://…>` autolink —
 * both already link nodes upstream — is never double-wrapped.
 *
 * Validation is delegated to `parseCloudSessionReference`, which fails
 * closed: anything malformed stays plain text rather than becoming a link
 * that resolves to nothing.
 */
import { parseCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/**
 * Case-insensitive to match `parseCloudSessionReference`, which compares a
 * lowercased scheme and host per the URL spec. A case-sensitive scan here
 * would linkify `[label](ORGII://…)` but not the same reference written
 * bare. Matched on the original string so indices need no remapping.
 */
const REFERENCE_SCHEME_PATTERN = /orgii:\/\//giu;

/**
 * Trailing characters stripped before validation so a reference ending a
 * sentence still linkifies. Consequence (same trade GFM autolinks make): a
 * session id whose last character is one of these cannot be linkified from
 * bare text — it stays plain rather than linking to a truncated id.
 */
const TRAILING_PUNCTUATION = /[.,;:!?"'\]})>]+$/u;

/** Parents whose text must not be re-linkified; links cannot nest. */
const LINK_BEARING_PARENTS = new Set([
  "link",
  "linkReference",
  "definition",
  "image",
  "imageReference",
]);

/**
 * Upper bound on a candidate's length. The grammar's fixed part is ~128
 * characters plus a session id, so this is generous for any real
 * reference. The bound is what keeps the scan linear: without it, text
 * carrying the scheme many times inside ONE whitespace-free run — a
 * minified JSON paste, a long url list — costs O(n²) on every render of
 * that markdown body.
 */
const MAX_REFERENCE_LENGTH = 512;

/**
 * End of the non-whitespace run at `start`, or null when the run is longer
 * than any legitimate reference. Fails closed rather than truncating: a
 * truncated candidate can still PARSE, which would linkify a valid-looking
 * reference to a session id nobody wrote.
 */
function candidateEnd(value: string, start: number): number | null {
  const cap = start + MAX_REFERENCE_LENGTH;
  let index = start;
  while (index < value.length && !/\s/u.test(value[index])) {
    if (index > cap) return null;
    index += 1;
  }
  return index;
}

/**
 * Split one text value into alternating text/link nodes, or null when it
 * carries no valid reference (the caller then keeps the original node).
 */
export function splitCloudSessionReferenceText(
  value: string
): MdastNode[] | null {
  const nodes: MdastNode[] = [];
  const scan = new RegExp(REFERENCE_SCHEME_PATTERN);
  let consumed = 0;

  for (;;) {
    const match = scan.exec(value);
    if (!match) break;
    const at = match.index;

    const end = candidateEnd(value, at);
    if (end === null) continue;

    const trimmed = value.slice(at, end).replace(TRAILING_PUNCTUATION, "");
    if (!trimmed || !parseCloudSessionReference(trimmed)) continue;

    if (at > consumed) {
      nodes.push({ type: "text", value: value.slice(consumed, at) });
    }
    nodes.push({
      type: "link",
      url: trimmed,
      children: [{ type: "text", value: trimmed }],
    });
    consumed = at + trimmed.length;
    scan.lastIndex = consumed;
  }

  if (nodes.length === 0) return null;
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
