import { sanitizeDomPreviewHtml } from "@src/features/DomSelection/domPreviewHtml";
import type {
  CanvasDomSelectionTargetSummary,
  DomSelectionElementInfo,
  DomSelectionRect,
} from "@src/features/DomSelection/types";
import i18n from "@src/i18n";
import { buildCssSelector } from "@src/util/core/error/componentIssueTracker/domAnalysis";
import { getReactComponentInfo } from "@src/util/core/error/componentIssueTracker/elementExtraction";
import { generatePreviewHtml } from "@src/util/core/error/componentIssueTracker/previewGenerator";

const INNER_HTML_LIMIT = 2_000;
const MAX_REGION_SCAN_ELEMENTS = 2_000;
const MAX_REGION_TARGETS = 12;
const MAX_PREVIEW_BACKGROUND_DEPTH = 12;

const SAFE_ATTRIBUTE_NAMES = new Set([
  "id",
  "class",
  "role",
  "name",
  "type",
  "title",
  "value",
]);

export interface CanvasDesignSelection {
  kind: "element" | "region";
  label: string;
  tooltipLabel: string;
  rect: DomSelectionRect;
  elementInfo: DomSelectionElementInfo;
  previewHtml?: string;
  targets?: CanvasDomSelectionTargetSummary[];
}

function isSafeAttribute(name: string): boolean {
  return (
    SAFE_ATTRIBUTE_NAMES.has(name) ||
    name.startsWith("aria-") ||
    name.startsWith("data-")
  );
}

function readAttributes(element: HTMLElement): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) {
    if (isSafeAttribute(attribute.name)) {
      attributes[attribute.name] = attribute.value.slice(0, 500);
    }
  }
  return attributes;
}

function siblingIndex(element: Element): number {
  return Array.from(element.parentElement?.children ?? []).indexOf(element) + 1;
}

function buildXPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    const tag = current.tagName.toLowerCase();
    const index = siblingIndex(current);
    parts.unshift(`${tag}[${Math.max(index, 1)}]`);
    const root = current.getRootNode();
    if (root instanceof ShadowRoot) {
      parts.unshift("shadow-root()");
      current = root.host;
    } else {
      current = current.parentElement;
    }
  }
  return `/${parts.join("/")}`;
}

function normalizeText(
  value: string | null | undefined,
  limit: number
): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function getDisplayLabel(element: HTMLElement): string {
  const reactName = getReactComponentInfo(element)?.name?.trim();
  return (
    element.dataset.component?.trim() ||
    reactName ||
    element.getAttribute("aria-label")?.trim() ||
    element.id.trim() ||
    element.tagName.toLowerCase()
  );
}

function rectFromDomRect(rect: DOMRect): DomSelectionRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function parentAcrossShadowBoundary(element: HTMLElement): HTMLElement | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement
    ? root.host
    : null;
}

function isTransparentBackground(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  return (
    normalized === "" ||
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)"
  );
}

function resolvePreviewBackgroundColor(element: HTMLElement): string | null {
  let current: HTMLElement | null = element;
  for (
    let depth = 0;
    current && depth < MAX_PREVIEW_BACKGROUND_DEPTH;
    depth++
  ) {
    try {
      const backgroundColor = window.getComputedStyle(current).backgroundColor;
      if (!isTransparentBackground(backgroundColor)) return backgroundColor;
    } catch {
      return null;
    }
    current = parentAcrossShadowBoundary(current);
  }
  return null;
}

function wrapPreviewWithContextBackground(
  previewHtml: string,
  backgroundColor: string | null
): string {
  if (!backgroundColor) return previewHtml;
  const wrapper = document.createElement("div");
  wrapper.dataset.canvasPreviewContext = "true";
  wrapper.style.display = "inline-flex";
  wrapper.style.maxWidth = "100%";
  wrapper.style.maxHeight = "100%";
  wrapper.style.padding = "12px";
  wrapper.style.borderRadius = "8px";
  wrapper.style.backgroundColor = backgroundColor;
  wrapper.innerHTML = previewHtml;
  return sanitizeDomPreviewHtml(wrapper.outerHTML);
}

export function buildCanvasPreviewHtml(element: HTMLElement): string {
  const backgroundColor = resolvePreviewBackgroundColor(element);
  try {
    const raw = generatePreviewHtml(element);
    const result = sanitizeDomPreviewHtml(raw);
    const contextualized = wrapPreviewWithContextBackground(
      result,
      backgroundColor
    );
    if (contextualized.length < 32_000) return contextualized;
  } catch {
    // Preview serialization is best-effort. Selection metadata remains useful
    // even when a browser-specific computed style cannot be read.
  }

  const fallback = document.createElement("div");
  try {
    const computed = window.getComputedStyle(element);
    fallback.style.cssText = [
      `color:${computed.color}`,
      `background:${computed.backgroundColor}`,
      `font:${computed.font}`,
      `padding:${computed.padding}`,
      `border:${computed.border}`,
      `border-radius:${computed.borderRadius}`,
    ].join(";");
  } catch {
    // Text-only fallback below still gives chat a stable visual placeholder.
  }
  fallback.textContent = normalizeText(element.textContent, 500);
  return wrapPreviewWithContextBackground(
    sanitizeDomPreviewHtml(fallback.outerHTML),
    backgroundColor
  );
}

export function captureCanvasElement(
  element: HTMLElement,
  options: { includePreview?: boolean } = {}
): CanvasDesignSelection {
  const rect = element.getBoundingClientRect();
  const computed = window.getComputedStyle(element);
  const label = getDisplayLabel(element);
  const tagName = element.tagName.toLowerCase();
  const info: DomSelectionElementInfo = {
    tagName,
    selector: buildCssSelector(element),
    id: element.id || null,
    className: element.className || null,
    attributes: readAttributes(element),
    innerText: normalizeText(element.innerText || element.textContent, 1_000),
    innerHTML: element.innerHTML.slice(0, INNER_HTML_LIMIT),
    rect: rectFromDomRect(rect),
    computedStyle: {
      display: computed.display,
      position: computed.position,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      fontSize: computed.fontSize,
      fontFamily: computed.fontFamily,
    },
    role: element.getAttribute("role") || tagName,
    xpath: buildXPath(element),
    sourceLocation: null,
  };

  return {
    kind: "element",
    label,
    tooltipLabel: `${label} · ${tagName}`,
    rect: info.rect,
    elementInfo: info,
    previewHtml:
      options.includePreview === false
        ? undefined
        : buildCanvasPreviewHtml(element),
  };
}

function visitInspectableElements(
  root: ParentNode,
  result: HTMLElement[]
): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (result.length >= MAX_REGION_SCAN_ELEMENTS) return;
    if (element.closest("[data-canvas-design-ui]")) continue;
    result.push(element);
    if (element.shadowRoot)
      visitInspectableElements(element.shadowRoot, result);
  }
}

function intersects(a: DomSelectionRect, b: DomSelectionRect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

export function captureCanvasRegion(
  root: HTMLElement,
  region: DomSelectionRect
): CanvasDesignSelection | null {
  const elements: HTMLElement[] = [];
  visitInspectableElements(root, elements);
  const matches = elements
    .map((element) => ({
      element,
      rect: rectFromDomRect(element.getBoundingClientRect()),
    }))
    .filter(({ rect }) => {
      const { width, height } = rect;
      return width >= 2 && height >= 2 && intersects(rect, region);
    })
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
    .slice(0, MAX_REGION_TARGETS);

  const primary = matches[0];
  if (!primary) return null;
  const primaryCapture = captureCanvasElement(primary.element);
  const targets = matches.map(({ element, rect }) => ({
    label: getDisplayLabel(element),
    selector: buildCssSelector(element),
    tagName: element.tagName.toLowerCase(),
    rect,
  }));
  const label =
    targets.length === 1
      ? primaryCapture.label
      : i18n.t("sessions:domSelection.elementsCount", {
          defaultValue: "{{count}} elements",
          count: targets.length,
        });

  return {
    ...primaryCapture,
    kind: "region",
    label,
    tooltipLabel: i18n.t("sessions:domSelection.regionLabel", {
      defaultValue: "Region · {{label}}",
      label,
    }),
    rect: region,
    targets,
  };
}

export function elementFromComposedPath(
  event: Event,
  root: HTMLElement
): HTMLElement | null {
  const path = event.composedPath();
  if (
    path.some(
      (item) =>
        item instanceof HTMLElement &&
        item.hasAttribute("data-canvas-design-ui")
    )
  ) {
    return null;
  }
  for (const item of path) {
    if (item === root) break;
    if (item instanceof HTMLElement) return item;
  }
  return null;
}
