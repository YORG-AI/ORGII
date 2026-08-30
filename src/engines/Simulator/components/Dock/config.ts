/**
 * Dock Configuration
 *
 * Centralized configuration for the simulator dock apps.
 */
import {
  Infinity01Icon,
  BubbleChatIcon,
  CodeIcon,
  FileDiffIcon,
  type IconSvgElement,
  InternetIcon,
  Layout01Icon,
  ListTodoIcon,
} from "@src/icons";

export interface DockApp {
  id: string;
  name: string;
  icon: IconSvgElement;
}

/** Agent Desk dock — agent activity apps only.
 *
 * Diff sits in its own leading segment so a `DockSegmentDivider` separates
 * it from the rest of the apps (mirrors the trailing divider before the
 * Background Tasks "infinity" pill). */
export const DOCK_APP_SEGMENTS: DockApp[][] = [
  [{ id: "DIFF", name: "Diff", icon: FileDiffIcon }],
  [
    { id: "CHANNELS", name: "Communication", icon: BubbleChatIcon },
    { id: "CODE_EDITOR", name: "Code Editor", icon: CodeIcon },
    { id: "BROWSER", name: "Browser", icon: InternetIcon },
    { id: "STORY_MANAGER", name: "Project Manager", icon: ListTodoIcon },
    { id: "CANVAS", name: "Canvas", icon: Layout01Icon },
  ],
];

export const DOCK_APPS: DockApp[] = DOCK_APP_SEGMENTS.flat();

export const BACKGROUND_TASKS_DOCK_APP: DockApp = {
  id: "BACKGROUND_TASKS",
  name: "Background Tasks",
  icon: Infinity01Icon,
};

export function getAppById(id: string): DockApp | undefined {
  return DOCK_APPS.find((app) => app.id === id);
}
