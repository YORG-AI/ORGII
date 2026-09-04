/**
 * DOM element kind detection — distinguishes native HTML elements, custom
 * Web Components (registered via the custom-elements API), and SVG elements.
 *
 * React components have no direct DOM footprint under their own name; they
 * always render as one of the three categories below.
 *
 * @example
 * ```typescript
 * import { isNativeElement, getElementKind, getElementDescription } from '@src/util/ui/dom/isNativeElement';
 *
 * const el = document.querySelector('div');
 * isNativeElement(el);          // true
 * getElementKind(el);           // "native"
 * getElementDescription(el);    // "<div> (native)"
 * ```
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The full set of standard HTML tag names as defined in the Living Standard.
 * A tag that is not in this set and contains no hyphen is treated as "unknown"
 * (e.g. obsolete/vendor tags like <blink>, <marquee> are intentionally excluded
 * from the "native" bucket to keep classification conservative).
 */
export const NATIVE_HTML_TAGS: ReadonlySet<string> = new Set([
  // Document metadata
  "html",
  "head",
  "title",
  "base",
  "link",
  "meta",
  "style",
  // Sections
  "body",
  "article",
  "section",
  "nav",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hgroup",
  "header",
  "footer",
  "address",
  "main",
  // Grouping
  "p",
  "hr",
  "pre",
  "blockquote",
  "ol",
  "ul",
  "menu",
  "li",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "div",
  // Inline text
  "a",
  "em",
  "strong",
  "small",
  "s",
  "cite",
  "q",
  "dfn",
  "abbr",
  "ruby",
  "rt",
  "rp",
  "data",
  "time",
  "code",
  "var",
  "samp",
  "kbd",
  "sub",
  "sup",
  "i",
  "b",
  "u",
  "mark",
  "bdi",
  "bdo",
  "span",
  "br",
  "wbr",
  // Edits
  "ins",
  "del",
  // Embedded
  "picture",
  "source",
  "img",
  "iframe",
  "embed",
  "object",
  "param",
  "video",
  "audio",
  "track",
  "map",
  "area",
  // Tabular
  "table",
  "caption",
  "colgroup",
  "col",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "td",
  "th",
  // Forms
  "form",
  "label",
  "input",
  "button",
  "select",
  "datalist",
  "optgroup",
  "option",
  "textarea",
  "output",
  "progress",
  "meter",
  "fieldset",
  "legend",
  // Interactive
  "details",
  "summary",
  "dialog",
  // Scripting / templates
  "script",
  "noscript",
  "template",
  "slot",
  "canvas",
  // SVG root — present in HTML contexts, namespace check handles the rest
  "svg",
  "math",
]);

/** Classification of a DOM element's origin. */
export type ElementKind = "native" | "custom-element" | "svg" | "unknown";

/**
 * Returns `true` when `el` is a standard HTML element whose tag name appears
 * in the HTML Living Standard.
 *
 * Custom elements (Web Components) and SVG elements return `false`.
 */
export function isNativeElement(el: Element): boolean {
  return getElementKind(el) === "native";
}

/**
 * Classifies a DOM element into one of four categories:
 *
 * - `"native"` — tag is in the HTML spec, no hyphen, not SVG namespace
 * - `"custom-element"` — tag contains a hyphen (Web Component spec requirement)
 * - `"svg"` — element's namespace URI is the SVG namespace
 * - `"unknown"` — tag without a hyphen that isn't in the known HTML set
 */
export function getElementKind(el: Element): ElementKind {
  if (el.namespaceURI === SVG_NAMESPACE) {
    return "svg";
  }

  const tag = el.tagName.toLowerCase();

  if (tag.includes("-")) {
    return "custom-element";
  }

  if (NATIVE_HTML_TAGS.has(tag)) {
    return "native";
  }

  return "unknown";
}

/**
 * Returns a human-readable description of the element suitable for dev tooling.
 *
 * Examples:
 * - `"<div> (native)"`
 * - `"<my-component> (custom element)"`
 * - `"<circle> (SVG)"`
 * - `"<blink> (unknown)"`
 */
export function getElementDescription(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const kind = getElementKind(el);

  const labels: Record<ElementKind, string> = {
    native: "native",
    "custom-element": "custom element",
    svg: "SVG",
    unknown: "unknown",
  };

  return `<${tag}> (${labels[kind]})`;
}
