/**
 * Icon Helper for Shortcut Actions
 *
 * Maps icon names (Lucide icon component names) to actual Lucide icon components.
 */
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle,
  Clock,
  Eye,
  FileEdit,
  FileText,
  Folder,
  GitBranch,
  GitMerge,
  Inbox,
  ListTodo,
  type LucideProps,
  Milestone,
  Play,
  PlayCircle,
  Repeat,
  Rocket,
  Settings2,
  Split,
  Terminal,
  Timer,
  Type,
} from "lucide-react";
import React, { type SVGProps } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("iconHelper");

type ActionIconProps = SVGProps<SVGSVGElement> & Pick<LucideProps, "size">;

// Icon name to component mapping
const ICON_MAP: Record<string, LucideIcon> = {
  // Core controls
  Terminal,
  Timer,
  Clock,
  GitBranch,
  Split,
  Repeat,

  // File operations
  FileEdit,
  FileText,
  Folder,

  // Session workflow stages
  Inbox, // intake
  ListTodo, // planning
  Play, // execution
  Eye, // review
  GitMerge, // merge
  Rocket, // start session
  Milestone, // when session reaches stage
  PlayCircle, // when session completes

  // Session workflow config
  Settings2,
  ArrowRight, // stage transition

  // When triggers
  AppWindow, // when app opens
  CheckCircle, // when work item status changes

  // Variable categories
  Type, // text variable
  ArrowLeftRight, // action input variable
} as const;

/**
 * Render an icon from an icon name string (Lucide icon component name)
 */
export function renderActionIcon(
  iconName: string,
  props?: ActionIconProps
): React.ReactNode {
  const IconComponent = ICON_MAP[iconName];
  if (!IconComponent) {
    log.warn(`Unknown icon name: ${iconName}`);
    return null;
  }
  return <IconComponent size={props?.size || 14} {...props} />;
}
