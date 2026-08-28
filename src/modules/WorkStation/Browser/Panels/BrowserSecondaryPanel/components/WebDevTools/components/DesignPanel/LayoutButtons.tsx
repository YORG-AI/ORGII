/**
 * LayoutButtons Component
 *
 * Display type selector (block, flex, grid, inline) as full-width TabPill.
 */
import React, { memo, useMemo } from "react";

import AnyIcon from "@src/components/AnyIcon";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import {
  DashboardSquare01Icon,
  LayoutTwoRowIcon,
  MinusSignIcon,
  SquareIcon,
} from "@src/icons";

// ============================================
// Types
// ============================================

export interface LayoutButtonsProps {
  /** Current display value */
  currentDisplay: string;
  /** Handler for display change */
  onDisplayChange: (display: string) => void;
  /** Whether buttons are disabled */
  disabled?: boolean;
}

// ============================================
// Constants
// ============================================

const DISPLAY_OPTIONS = [
  { value: "block", label: "Block", icon: SquareIcon },
  { value: "flex", label: "Flex", icon: LayoutTwoRowIcon },
  { value: "grid", label: "Grid", icon: DashboardSquare01Icon },
  { value: "inline", label: "Inline", icon: MinusSignIcon },
] as const;

// ============================================
// Component
// ============================================

export const LayoutButtons: React.FC<LayoutButtonsProps> = memo(
  ({ currentDisplay, onDisplayChange, disabled = false }) => {
    const normalizedDisplay = currentDisplay.toLowerCase().split(" ")[0];

    const activeTab =
      DISPLAY_OPTIONS.find((option) => option.value === normalizedDisplay)
        ?.value ?? "";

    const tabs: TabPillItem[] = useMemo(
      () =>
        DISPLAY_OPTIONS.map((option) => {
          const Icon = option.icon;
          return {
            key: option.value,
            label: option.label,
            icon: (
              <AnyIcon
                icon={Icon}
                size={14}
                strokeWidth={1.75}
                className="shrink-0"
              />
            ),
            disabled,
          };
        }),
      [disabled]
    );

    return (
      <TabPill
        variant="pill"
        color="fill"
        size="small"
        fillWidth
        wrap
        className="w-full min-w-0"
        tabs={tabs}
        activeTab={activeTab}
        onChange={onDisplayChange}
      />
    );
  }
);

LayoutButtons.displayName = "LayoutButtons";

export default LayoutButtons;
