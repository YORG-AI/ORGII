export const SEARCH_TEXT_HIGHLIGHT_CLASS = "search-text-highlight";
export const SEARCH_TEXT_HIGHLIGHT_ACTIVE_CLASS =
  "search-text-highlight--active";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "MARK"]);

export function clearSearchTextHighlights(container: HTMLElement) {
  container
    .querySelectorAll(
      `mark.${SEARCH_TEXT_HIGHLIGHT_CLASS}, mark.${SEARCH_TEXT_HIGHLIGHT_ACTIVE_CLASS}`
    )
    .forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(
        document.createTextNode(mark.textContent || ""),
        mark
      );
      parent.normalize();
    });
}

function highlightFirstMatch(node: Node, query: string) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || "";
    const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
    if (matchIndex < 0) return;

    const range = document.createRange();
    range.setStart(node, matchIndex);
    range.setEnd(node, matchIndex + query.length);
    const mark = document.createElement("mark");
    mark.className = SEARCH_TEXT_HIGHLIGHT_CLASS;
    range.surroundContents(mark);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  if (
    SKIP_TAGS.has(element.tagName) ||
    element.classList.contains(SEARCH_TEXT_HIGHLIGHT_CLASS) ||
    element.classList.contains(SEARCH_TEXT_HIGHLIGHT_ACTIVE_CLASS)
  ) {
    return;
  }

  Array.from(node.childNodes).forEach((child) =>
    highlightFirstMatch(child, query)
  );
}

/** Case-insensitive DOM substring highlight for the active search query. */
export function applySearchTextHighlight(
  container: HTMLElement | null,
  query: string,
  enabled: boolean
) {
  if (!container) return;
  clearSearchTextHighlights(container);
  const trimmedQuery = query.trim();
  if (!enabled || !trimmedQuery) return;
  highlightFirstMatch(container, trimmedQuery);
}
