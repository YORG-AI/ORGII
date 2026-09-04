import type React from "react";

import type { SlashItem } from "@src/types/extensions";

export interface SlashCommandPortalProps {
  visible: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Optional descendant of containerRef to anchor the menu against. */
  anchorSelector?: string;
  /** Skills available to the `/` menu. Non-skill rows are ignored. */
  items: SlashItem[];
  loading: boolean;
  /** Query typed after `/`; items are already loaded upstream. */
  searchQuery?: string;
  onClose: () => void;
  onSelect: (item: SlashItem) => void;
  keyboardHandlerRef: React.MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
}

interface SlashEntry {
  kind: "item";
  item: SlashItem;
  flatIndex: number;
}

export interface SectionHeader {
  kind: "header";
  label: string;
  translationKey?: string;
}

interface DividerEntry {
  kind: "divider";
}

export type ListEntry = SlashEntry | SectionHeader | DividerEntry;
