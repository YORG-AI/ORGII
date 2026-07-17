import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineAppActionRegistration } from "@src/ActionSystem/schema/actionRegistration";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { zodActionRegistry } from "@src/ActionSystem/schema/zodRegistry";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { TUTORIALS } from "@src/scaffold/Tutorials/tutorialRegistry";
import { collectAppUiSnapshot } from "@src/services/context/appUiSnapshot";
import {
  clearGuideHighlightAtom,
  showGuideHighlightAtom,
} from "@src/store/ui/guideHighlightAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { getViewportSize } from "@src/util/ui/window/viewport";

const GUI_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[tabindex]:not([tabindex='-1'])",
  "[data-action]",
  "[data-gui-action]",
  "[data-gui-label]",
].join(",");

const MAX_DOM_CONTROLS = 160;
const MAX_ACTIONS = 180;
const MAX_TEXT_LENGTH = 140;
const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "bring",
  "go",
  "me",
  "open",
  "please",
  "show",
  "take",
  "the",
  "to",
]);

interface GuiManifestDomControl {
  kind: "dom";
  id: string;
  label: string;
  role: string;
  tagName: string;
  action?: string;
  description?: string;
  disabled: boolean;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface GuiManifest {
  actions: ReturnType<
    typeof zodActionRegistry.getGUIControlManifest
  >["actions"];
  controls: GuiManifestDomControl[];
  guides: typeof TUTORIALS;
  guideTargets: Array<{ id: string; label: string }>;
}

function truncateText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_TEXT_LENGTH
    ? `${compact.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : compact;
}

function tokenizeQuery(query?: string): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
}

function matchesQuery(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const normalizedHaystack = haystack.toLowerCase();
  const matchCount = tokens.filter((token) =>
    normalizedHaystack.includes(token)
  ).length;
  const requiredMatches = Math.min(tokens.length, 2);
  return matchCount >= requiredMatches;
}

function isElementVisible(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  const { width: vw, height: vh } = getViewportSize();
  if (rect.top > vh || rect.left > vw) return false;
  const style = window.getComputedStyle(element);
  return (
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    Number(style.opacity || "1") > 0
  );
}

function getElementRole(element: HTMLElement): string {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) return explicitRole;
  const tagName = element.tagName.toLowerCase();
  if (tagName === "button") return "button";
  if (tagName === "a") return "link";
  if (tagName === "input") {
    const input = element as HTMLInputElement;
    return input.type || "input";
  }
  return tagName;
}

function getAssociatedLabel(element: HTMLElement): string | null {
  if (element instanceof HTMLInputElement && element.labels?.length) {
    return Array.from(element.labels)
      .map((label) => label.textContent ?? "")
      .join(" ")
      .trim();
  }
  return null;
}

function getAccessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return truncateText(text);
  }

  const candidates = [
    element.getAttribute("data-gui-label"),
    element.getAttribute("aria-label"),
    getAssociatedLabel(element),
    element.getAttribute("title"),
    element.textContent,
    element.getAttribute("placeholder"),
    element.getAttribute("data-action"),
    element.getAttribute("data-gui-action"),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0)
      return truncateText(candidate);
  }

  return getElementRole(element);
}

function isDisabled(element: HTMLElement): boolean {
  if (element.getAttribute("aria-disabled") === "true") return true;
  if (element instanceof HTMLButtonElement) return element.disabled;
  if (element instanceof HTMLInputElement) return element.disabled;
  if (element instanceof HTMLTextAreaElement) return element.disabled;
  if (element instanceof HTMLSelectElement) return element.disabled;
  return false;
}

function buildDomControl(
  element: HTMLElement,
  index: number
): GuiManifestDomControl {
  const rect = element.getBoundingClientRect();
  const action =
    element.getAttribute("data-gui-action") ??
    element.getAttribute("data-action") ??
    undefined;
  const description = element.getAttribute("data-gui-description") ?? undefined;
  const selected = element.getAttribute("aria-selected");
  const expanded = element.getAttribute("aria-expanded");
  const checked = element.getAttribute("aria-checked");

  return {
    kind: "dom",
    id: `dom:${index}`,
    label: getAccessibleName(element),
    role: getElementRole(element),
    tagName: element.tagName.toLowerCase(),
    ...(action ? { action } : {}),
    ...(description ? { description } : {}),
    disabled: isDisabled(element),
    ...(selected ? { selected: selected === "true" } : {}),
    ...(expanded ? { expanded: expanded === "true" } : {}),
    ...(checked ? { checked: checked === "true" } : {}),
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function collectDomControls(query?: string): GuiManifestDomControl[] {
  const queryTokens = tokenizeQuery(query);
  const elements = Array.from(document.querySelectorAll(GUI_CONTROL_SELECTOR));
  const controls = elements
    .filter(isElementVisible)
    .map(buildDomControl)
    .filter((control) => {
      const haystack = [
        control.label,
        control.role,
        control.action,
        control.description,
        control.tagName,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      return matchesQuery(haystack, queryTokens);
    })
    .slice(0, MAX_DOM_CONTROLS);

  return controls;
}

function collectGuiActions(query?: string): GuiManifest["actions"] {
  const queryTokens = tokenizeQuery(query);
  return zodActionRegistry
    .getGUIControlManifest()
    .actions.filter((action) => {
      if (action.id === ACTION_ID.GUI_INSPECT) return false;
      if (action.id === ACTION_ID.GUI_EXECUTE) return false;
      const haystack = [
        action.id,
        action.category,
        action.description,
        action.longDescription,
        ...(action.tags ?? []),
        ...(action.examples ?? []),
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ");
      return matchesQuery(haystack, queryTokens);
    })
    .slice(0, MAX_ACTIONS);
}

function buildGuideTargets(): GuiManifest["guideTargets"] {
  return Object.values(GUIDE_TARGETS).map((id) => ({
    id,
    label: id,
  }));
}

function buildGuiManifest(query?: string): GuiManifest {
  return {
    actions: collectGuiActions(query),
    controls: collectDomControls(query),
    guides: TUTORIALS,
    guideTargets: buildGuideTargets(),
  };
}

function findDomControlElement(targetId: string): HTMLElement | null {
  const indexText = targetId.startsWith("dom:") ? targetId.slice(4) : "";
  const index = Number.parseInt(indexText, 10);
  if (!Number.isInteger(index) || index < 0) return null;
  const elements = Array.from(document.querySelectorAll(GUI_CONTROL_SELECTOR));
  return elements.filter(isElementVisible)[index] ?? null;
}

function setNativeValue(element: HTMLElement, value: string): boolean {
  if (element instanceof HTMLInputElement) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (element instanceof HTMLTextAreaElement) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (element instanceof HTMLSelectElement) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

const GuiInspectParamsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional text filter for actions and visible controls"),
});

const GuiContextParamsSchema = z.object({});

const GuideListParamsSchema = z.object({});

const GuideStartParamsSchema = z.object({
  guideId: z.enum(["general-layout", "code-editor"]).describe("Guide to start"),
});

const GuideHighlightTargetParamsSchema = z.object({
  targetId: z.string().describe("Stable guide target ID to highlight"),
  title: z.string().optional().describe("Optional highlight title"),
  message: z.string().describe("Short user-facing guide message"),
});

const GuideClearHighlightParamsSchema = z.object({});

const GuiExecuteParamsSchema = z.object({
  targetKind: z.enum(["action", "dom"]),
  actionId: z
    .string()
    .optional()
    .describe("Registered Zod action ID when targetKind is action"),
  targetId: z
    .string()
    .optional()
    .describe("DOM target id from gui.inspect when targetKind is dom"),
  operation: z
    .enum(["click", "focus", "set_value"])
    .optional()
    .describe("DOM operation. Defaults to click."),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Params for action execution"),
  value: z.string().optional().describe("Value for set_value DOM operation"),
});

export const guiInspectAction = defineZodAction(
  {
    id: ACTION_ID.GUI_INSPECT,
    category: "app",
    description:
      "Inspect registered GUI actions and currently visible controls",
    params: GuiInspectParamsSchema,
    layer: "gui",
    tags: ["gui", "inspect", "manifest", "actions", "controls"],
    examples: [
      "what GUI controls are available",
      "find source control actions",
    ],
  },
  async ({ query }) => ({
    success: true,
    message: "Collected GUI manifest",
    data: buildGuiManifest(query),
  })
);

export const guiContextAction = defineZodAction(
  {
    id: ACTION_ID.GUI_CONTEXT,
    category: "app",
    description:
      "Inspect the current ORGII UI context: route, station, active tab, active session, browser URL, chat surface, overlays, and visible guide targets",
    params: GuiContextParamsSchema,
    layer: "gui",
    tags: ["gui", "context", "route", "station", "tab", "session", "url"],
    examples: [
      "what screen is selected",
      "which station and tab are active",
      "what URL is open",
    ],
  },
  async () => ({
    success: true,
    message: "Collected GUI context",
    data: collectAppUiSnapshot(),
  })
);

export const guideListAction = defineZodAction(
  {
    id: ACTION_ID.GUIDE_LIST,
    category: "app",
    description: "List available tutorials and stable guide highlight targets",
    params: GuideListParamsSchema,
    layer: "gui",
    tags: ["guide", "tutorial", "highlight", "targets"],
    examples: ["what tutorials are available", "what can you highlight"],
  },
  async () => ({
    success: true,
    message: "Collected guide registry",
    data: {
      guides: TUTORIALS,
      guideTargets: buildGuideTargets(),
      visibleGuideTargets: collectAppUiSnapshot()?.visibleGuideTargets ?? [],
    },
  })
);

export const guideStartAction = defineZodAction(
  {
    id: ACTION_ID.GUIDE_START,
    category: "app",
    description: "Start an interactive built-in tutorial",
    params: GuideStartParamsSchema,
    layer: "gui",
    tags: ["guide", "tutorial", "tour", "start"],
    examples: ["start the layout tour", "guide me through code editor"],
  },
  async ({ guideId }) => {
    const tutorial = TUTORIALS.find((entry) => entry.id === guideId);
    if (!tutorial) {
      return { success: false, message: `Unknown guide: ${guideId}` };
    }
    window.dispatchEvent(new CustomEvent(tutorial.eventName));
    return { success: true, message: `Started guide: ${tutorial.title}` };
  }
);

export const guideHighlightTargetAction = defineZodAction(
  {
    id: ACTION_ID.GUIDE_HIGHLIGHT_TARGET,
    category: "app",
    description:
      "Highlight a stable UI target and show a short guide message to the user",
    params: GuideHighlightTargetParamsSchema,
    layer: "gui",
    tags: ["guide", "highlight", "target", "tutorial"],
    examples: ["highlight the chat panel", "show where the dock is"],
  },
  async ({ targetId, title, message }) => {
    getInstrumentedStore().set(showGuideHighlightAtom, {
      targetId,
      title,
      message,
    });
    return { success: true, message: `Highlighted ${targetId}` };
  }
);

export const guideClearHighlightAction = defineZodAction(
  {
    id: ACTION_ID.GUIDE_CLEAR_HIGHLIGHT,
    category: "app",
    description: "Clear the current guide highlight overlay",
    params: GuideClearHighlightParamsSchema,
    layer: "gui",
    tags: ["guide", "highlight", "clear", "dismiss"],
  },
  async () => {
    getInstrumentedStore().set(clearGuideHighlightAtom);
    return { success: true, message: "Cleared guide highlight" };
  }
);

export const guiExecuteAction = defineZodAction(
  {
    id: ACTION_ID.GUI_EXECUTE,
    category: "app",
    description:
      "Execute a registered GUI action or operate on a visible DOM control",
    params: GuiExecuteParamsSchema,
    layer: "gui",
    tags: ["gui", "execute", "action", "dom", "click", "focus"],
    examples: ["click a visible control", "run a GUI action from the manifest"],
  },
  async ({
    targetKind,
    actionId,
    targetId,
    operation = "click",
    params,
    value,
  }) => {
    if (targetKind === "action") {
      if (!actionId) {
        return {
          success: false,
          message: "actionId is required for action targets",
        };
      }
      if (
        actionId === ACTION_ID.GUI_EXECUTE ||
        actionId === ACTION_ID.GUI_INSPECT
      ) {
        return {
          success: false,
          message: "GUI meta-actions cannot execute themselves",
        };
      }
      if (actionId === ACTION_ID.SESSION_REPLY_COMMENT) {
        return {
          success: false,
          message:
            "session.replyComment cannot be run through gui.execute; it is only reachable via its own reply tool, which binds the reply to the invoking session.",
        };
      }
      return zodActionRegistry.execute(actionId, params ?? {});
    }

    if (!targetId) {
      return {
        success: false,
        message: "targetId is required for DOM targets",
      };
    }

    const element = findDomControlElement(targetId);
    if (!element) {
      return {
        success: false,
        message: `DOM target ${targetId} is no longer visible`,
      };
    }
    if (isDisabled(element)) {
      return { success: false, message: `DOM target ${targetId} is disabled` };
    }

    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "smooth",
    });

    if (operation === "focus") {
      element.focus();
      return {
        success: true,
        message: `Focused ${getAccessibleName(element)}`,
      };
    }

    if (operation === "set_value") {
      if (typeof value !== "string") {
        return { success: false, message: "value is required for set_value" };
      }
      const changed = setNativeValue(element, value);
      return changed
        ? { success: true, message: `Set ${getAccessibleName(element)}` }
        : {
            success: false,
            message: `DOM target ${targetId} does not accept values`,
          };
    }

    element.click();
    return { success: true, message: `Clicked ${getAccessibleName(element)}` };
  }
);

export const guiControlZodActions = [
  guiInspectAction,
  guiContextAction,
  guiExecuteAction,
  guideListAction,
  guideStartAction,
  guideHighlightTargetAction,
  guideClearHighlightAction,
];

export const guiControlActionRegistration =
  defineAppActionRegistration(guiControlZodActions);
