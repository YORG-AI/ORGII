/**
 * Dock Configuration
 *
 * Centralized configuration for the simulator dock apps.
 */
import type { LucideIcon } from "lucide-react";
import {
  Infinity,
  Chromium,
  Code,
  GitBranch,
  Layout,
  ListTodo,
  MessageCircle,
} from "lucide-react";

export interface DockApp {
  id: string;
  name: string;
  icon: LucideIcon;
}

/** Agent Desk dock — agent activity apps only.
 *
 * Diff sits in its own leading segment so a `DockSegmentDivider` separates
 * it from the rest of the apps (mirrors the trailing divider before the
 * Background Tasks "infinity" pill). */
export const DOCK_APP_SEGMENTS: DockApp[][] = [
  [{ id: "DIFF", name: "Diff", icon: GitBranch }],
  [
    { id: "CHANNELS", name: "Communication", icon: MessageCircle },
    { id: "CODE_EDITOR", name: "Code Editor", icon: Code },
    { id: "BROWSER", name: "Browser", icon: Chromium },
    { id: "STORY_MANAGER", name: "Project Manager", icon: ListTodo },
    { id: "CANVAS", name: "Canvas", icon: Layout },
  ],
];

export const DOCK_APPS: DockApp[] = DOCK_APP_SEGMENTS.flat();

export const BACKGROUND_TASKS_DOCK_APP: DockApp = {
  id: "BACKGROUND_TASKS",
  name: "Background Tasks",
  icon: Infinity,
};

export function getAppById(id: string): DockApp | undefined {
  return DOCK_APPS.find((app) => app.id === id);
}
