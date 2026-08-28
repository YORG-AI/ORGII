/**
 * Chat models configuration (shared)
 *
 * IMPORTANT:
 * - This file must NOT import `WorkspaceContext` barrel exports to avoid circular deps.
 * - Keep this module UI-light and side-effect free; it is imported by `ChatContext`.
 */
import {
  Book01Icon,
  CodeIcon,
  File02Icon,
  HugeiconsIcon,
  SparklesIcon,
} from "@src/icons";

export const chat_models = [
  {
    icon: (
      <HugeiconsIcon
        icon={SparklesIcon}
        data-icon="sparkles"
        className="text-[16px] text-text-2"
        size={16}
      />
    ),
    title: "Autodetect",
    key: "auto",
  },
  {
    icon: (
      <HugeiconsIcon
        icon={CodeIcon}
        data-icon="code"
        className="text-[16px] text-text-2"
        size={16}
      />
    ),
    title: "Chat Codebase",
    key: "codebase",
  },
  {
    icon: (
      <HugeiconsIcon
        icon={Book01Icon}
        data-icon="book"
        className="text-[16px] text-text-2"
        size={16}
      />
    ),
    title: "Context",
    key: "context",
  },
  {
    icon: (
      <HugeiconsIcon
        icon={File02Icon}
        data-icon="file-text"
        size={16}
        strokeWidth={1.75}
        className="text-text-2"
      />
    ),
    title: "Spec",
    key: "spec",
  },
  {
    icon: (
      <HugeiconsIcon
        icon={File02Icon}
        data-icon="file-text"
        size={16}
        strokeWidth={1.75}
        className="text-text-2"
      />
    ),
    title: "Planner",
    key: "planner",
  },
] as const;
