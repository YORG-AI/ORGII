/**
 * Build a DomComponentPreview-compatible JSON blob from a webview
 * `ElementInfo` capture so Browser "send selected element to chat" can emit
 * the same `paste://` pill shape produced by clipboard JSON paste.
 *
 * Field mapping is documented in the plan
 * `browser-inspect-composershell-json-paste-pill_fb3c6f42.plan.md`.
 * The DomComponentPreview parser is permissive (`ParsedDomComponent` only
 * reads `cssSelector`, `dimensions`, `reactComponent`, `domPath`, `meta`),
 * so additional shape fields are safe to include for the Raw / MetaStrip
 * views and for the agent's downstream consumption.
 *
 * Preview limitation: `findHostElement` resolves `cssSelector` against the
 * main-window `document`, so a selector pointing into a Tauri webview will
 * miss and render the placeholder. That's expected — Raw + MetaStrip still
 * carry the useful payload.
 */
import type { ElementInfo } from "../hooks/useWebviewInspector";

export interface BuiltDomComponent {
  /** Pretty-printed JSON suitable for storing in the pill-text side store. */
  jsonText: string;
  /** Pill display name, e.g. "ComposerShell.json" or "div.json". */
  fileName: string;
}

const NEARBY_TEXT_LIMIT = 200;
const PILL_NAME_MAX_LENGTH = 32;

function buildFileName(element: ElementInfo): string {
  const componentName = element.sourceLocation?.componentName?.trim();
  const tag = element.tagName?.toLowerCase() || "element";
  const base = componentName || tag;
  const truncated =
    base.length > PILL_NAME_MAX_LENGTH
      ? base.slice(0, PILL_NAME_MAX_LENGTH)
      : base;
  return `${truncated}.json`;
}

function filterDataAttributes(
  attributes: Record<string, string> | null | undefined
): Record<string, string> {
  if (!attributes) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("data-")) {
      result[key] = value;
    }
  }
  return result;
}

export function buildDomComponentJsonFromElementInfo(
  element: ElementInfo,
  pageUrl: string | undefined
): BuiltDomComponent {
  const className = element.className ?? "";
  const componentName =
    element.sourceLocation?.componentName ?? element.tagName ?? "element";

  const componentSuggestions = element.sourceLocation?.path
    ? [
        {
          name: componentName,
          confidence: "high" as const,
          filePath: element.sourceLocation.path,
          matchReason: element.sourceLocation.method,
          line: element.sourceLocation.line ?? null,
        },
      ]
    : [];

  const payload = {
    componentLabel: `className="${className}"`,
    cssSelector: element.selector,
    xpath: element.xpath,
    role: element.role,
    domPath: [] as string[],
    reactComponent: {
      name: componentName,
    },
    dimensions: {
      width: element.rect.width,
      height: element.rect.height,
    },
    position: {
      top: element.rect.y,
      left: element.rect.x,
      position: element.computedStyle?.position ?? "static",
    },
    contextClues: {
      nearbyText: (element.innerText ?? "").slice(0, NEARBY_TEXT_LIMIT),
      siblingElement: [] as string[],
    },
    dataAttributes: filterDataAttributes(element.attributes),
    componentSuggestions,
    meta: {
      url: pageUrl ?? "",
      timestamp: new Date().toISOString(),
      viewport: {
        width: typeof window !== "undefined" ? window.innerWidth : 0,
        height: typeof window !== "undefined" ? window.innerHeight : 0,
      },
    },
  };

  return {
    jsonText: JSON.stringify(payload, null, 2),
    fileName: buildFileName(element),
  };
}
