import DOMPurify from "dompurify";

function sanitizePreviewStyles(container: ParentNode): void {
  container.querySelectorAll<HTMLElement>("[style]").forEach((node) => {
    const declarations = (node.getAttribute("style") ?? "")
      .split(";")
      .filter((declaration) => {
        const normalized = declaration.toLowerCase();
        return (
          !normalized.includes("url(") &&
          !normalized.includes("expression(") &&
          !normalized.includes("@import")
        );
      });
    node.setAttribute("style", declarations.join(";"));
  });
}

/**
 * Sanitizes captured Canvas markup for inert previews. Network-bearing
 * attributes are removed so re-rendering a historical message cannot refetch
 * resources or navigate the app.
 */
export function sanitizeDomPreviewHtml(
  value: string,
  maxLength = Number.POSITIVE_INFINITY
): string {
  const sanitized = DOMPurify.sanitize(value, {
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "link",
      "meta",
      "base",
    ],
    FORBID_ATTR: [
      "src",
      "srcset",
      "href",
      "poster",
      "action",
      "formaction",
      "srcdoc",
    ],
  });
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  sanitizePreviewStyles(template.content);
  const result = template.innerHTML;
  if (result.length <= maxLength) return result;

  const fallback = document.createElement("div");
  fallback.textContent = (template.content.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.min(2_000, maxLength));
  return fallback.outerHTML;
}
