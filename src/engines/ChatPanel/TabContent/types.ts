/**
 * Chat Panel tab content registry types.
 *
 * Mirrors the WorkStation `TabContent` registry (`src/modules/WorkStation/
 * TabContent/`): a single, exhaustive map from `ChatPanelTabType` to how that
 * tab's content is rendered. Session and Launchpad render in the shared "chat
 * column"; Kanban and terminals get their own keep-alive layers; every other
 * surface renders a dedicated, self-sufficient component that reads its tab
 * payload. An unrecognized type resolves to an explicit placeholder instead of
 * silently falling back to the Launchpad.
 */
import type React from "react";

import type { ChatPanelTabType } from "@src/store/chatPanel/chatPanelTabsAtom";

import type { ChatPanelSurfaceRendererProps } from "./surfaceRenderers";

export type ChatPanelTabSurfaceEntry =
  | { render: "chat-column"; debugLabel?: string }
  | { render: "work-management"; debugLabel?: string }
  | { render: "terminal"; debugLabel?: string }
  | {
      render: "component";
      Component: React.ComponentType<ChatPanelSurfaceRendererProps>;
      debugLabel?: string;
    };

/** Exhaustive map — every `ChatPanelTabType` must have an entry. */
export type ChatPanelTabSurfaceRegistry = Record<
  ChatPanelTabType,
  ChatPanelTabSurfaceEntry
>;
