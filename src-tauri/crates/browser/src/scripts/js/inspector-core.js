// Element Inspector Core - State, Overlays, and Base Utilities
// This file is included via include_str! in inspector.rs

// State
let inspectEnabled = false;
let selectedElement = null;
let hoveredElement = null;

// Drag state
let isDragging = false;
let draggedElement = null;
let dragStartX = 0;
let dragStartY = 0;
const DRAG_THRESHOLD = 5; // pixels before drag starts

// Brand primary-6 — mirrors --color-primary-6 in public/orgii_main.css
// (rgb(29, 143, 253)). The webview is isolated from app CSS variables,
// so this color is inlined here.
const ORGII_PRIMARY_6 = "#1D8FFD";
const ORGII_PRIMARY_6_RGBA_10 = "rgba(29, 143, 253, 0.1)";
const ORGII_PRIMARY_6_SHADOW = "rgba(29, 143, 253, 0.35)";

// Inspect mode owns page interaction while active. Use non-passive capture
// listeners so links, SPA routers, buttons, forms, and drag handlers cannot
// navigate or mutate the page before the inspector selects the target.
const INSPECT_EVENT_OPTIONS = { capture: true, passive: false };

const suppressInspectEvent = (e) => {
  if (!inspectEnabled) return false;

  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") {
    e.stopImmediatePropagation();
  }
  return true;
};

// Create overlay elements
const highlightOverlay = document.createElement("div");
highlightOverlay.id = "__orgii_highlight_overlay__";
highlightOverlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483646;
    border: 2px solid ${ORGII_PRIMARY_6};
    background: ${ORGII_PRIMARY_6_RGBA_10};
    display: none;
    box-sizing: border-box;
`;

const infoTooltip = document.createElement("div");
infoTooltip.id = "__orgii_info_tooltip__";
infoTooltip.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    background: ${ORGII_PRIMARY_6};
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 11px;
    padding: 6px 10px;
    border-radius: 4px;
    display: none;
    max-width: 400px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 2px 8px ${ORGII_PRIMARY_6_SHADOW};
`;

// Selected element overlay (different color)
const selectedOverlay = document.createElement("div");
selectedOverlay.id = "__orgii_selected_overlay__";
selectedOverlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    border: 2px solid #f59e0b;
    background: rgba(245, 158, 11, 0.1);
    display: none;
    box-sizing: border-box;
`;

// Drop indicator (blue line showing where element will be inserted)
const dropIndicator = document.createElement("div");
dropIndicator.id = "__orgii_drop_indicator__";
dropIndicator.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483648;
    background: #3b82f6;
    height: 3px;
    border-radius: 2px;
    display: none;
    box-shadow: 0 0 4px rgba(59, 130, 246, 0.5);
`;

// Append to document when ready
const appendOverlays = () => {
  if (!document.body) {
    setTimeout(appendOverlays, 50);
    return;
  }
  document.body.appendChild(highlightOverlay);
  document.body.appendChild(infoTooltip);
  document.body.appendChild(selectedOverlay);
  document.body.appendChild(dropIndicator);
};
appendOverlays();

// Get element selector (tag#id.class1.class2)
const getElementSelector = (el) => {
  if (!el || !el.tagName) return "";
  let selector = el.tagName.toLowerCase();
  if (el.id) selector += "#" + el.id;
  if (el.className && typeof el.className === "string") {
    const classes = el.className
      .trim()
      .split(/\s+/)
      .filter((c) => c && !c.startsWith("__orgii"));
    if (classes.length > 0) {
      selector += "." + classes.slice(0, 3).join(".");
      if (classes.length > 3) selector += "...";
    }
  }
  return selector;
};

// Get XPath for element
const getXPath = (el) => {
  if (!el) return "";
  const parts = [];
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = el.previousSibling;
    while (sibling) {
      if (
        sibling.nodeType === Node.ELEMENT_NODE &&
        sibling.tagName === el.tagName
      ) {
        index++;
      }
      sibling = sibling.previousSibling;
    }
    const tagName = el.tagName.toLowerCase();
    const part = index > 1 ? `${tagName}[${index}]` : tagName;
    parts.unshift(part);
    el = el.parentNode;
  }
  return "/" + parts.join("/");
};

// Position overlay on element
const positionOverlay = (overlay, el) => {
  if (!el) {
    overlay.style.display = "none";
    return;
  }
  const rect = el.getBoundingClientRect();
  overlay.style.left = rect.left + "px";
  overlay.style.top = rect.top + "px";
  overlay.style.width = rect.width + "px";
  overlay.style.height = rect.height + "px";
  overlay.style.display = "block";
};

// Position tooltip adaptively — outside the rect when there's room,
// otherwise inside the top-left corner so the label stays visible for
// large elements (full-viewport frames, sticky headers, etc).
const TOOLTIP_GAP = 4;
const TOOLTIP_EDGE_MARGIN = 5;

const positionTooltip = (el, text) => {
  if (!el) {
    infoTooltip.style.display = "none";
    return;
  }
  const rect = el.getBoundingClientRect();
  infoTooltip.textContent = text;
  infoTooltip.style.display = "block";

  const tooltipRect = infoTooltip.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  // Vertical placement preference:
  //   1. Above the rect (outside, classic DevTools behavior)
  //   2. Below the rect (outside, fallback for elements near the top)
  //   3. Inside the rect, anchored to its top edge (for elements that
  //      span the viewport — "within" mode, matches Cursor inspector)
  let top;
  const spaceAbove = rect.top;
  const spaceBelow = viewportH - rect.bottom;
  const needed = tooltipRect.height + TOOLTIP_GAP;

  if (spaceAbove >= needed) {
    top = rect.top - tooltipRect.height - TOOLTIP_GAP;
  } else if (spaceBelow >= needed) {
    top = rect.bottom + TOOLTIP_GAP;
  } else {
    // Element is too tall for outside placement — dock inside the rect.
    const insideTop = Math.max(rect.top, TOOLTIP_EDGE_MARGIN) + TOOLTIP_GAP;
    top = Math.min(
      insideTop,
      viewportH - tooltipRect.height - TOOLTIP_EDGE_MARGIN
    );
  }

  // Horizontal placement: align to the element's left edge, clamped to
  // the viewport. For wide elements this still reads naturally; for
  // narrow elements it sits directly above/below them.
  let left = Math.max(rect.left, TOOLTIP_EDGE_MARGIN);
  if (left + tooltipRect.width > viewportW - TOOLTIP_EDGE_MARGIN) {
    left = viewportW - tooltipRect.width - TOOLTIP_EDGE_MARGIN;
  }
  if (left < TOOLTIP_EDGE_MARGIN) left = TOOLTIP_EDGE_MARGIN;

  infoTooltip.style.top = top + "px";
  infoTooltip.style.left = left + "px";
};

// Is element part of our overlay UI?
const isOverlayElement = (el) => {
  if (!el) return false;
  return el.id && el.id.startsWith("__orgii_");
};

// Check if element can be dragged
const isUndraggable = (el) => {
  if (!el || !el.tagName) return true;
  const tag = el.tagName.toLowerCase();
  return [
    "html",
    "head",
    "body",
    "script",
    "style",
    "link",
    "meta",
    "noscript",
  ].includes(tag);
};

// Get element by XPath (utility)
const getElementByXPath = (xpath) => {
  if (!xpath) return null;
  try {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue;
  } catch (e) {
    console.error("[Orgii DOM Editor] Invalid xpath:", e);
    return null;
  }
};
