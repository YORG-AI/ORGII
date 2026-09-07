import React from "react";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";

export interface DetailHeaderIconActionProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  testId?: string;
  disabled?: boolean;
}

/** Shared icon-only action for list/detail pane headers and tab strips. */
const DetailHeaderIconAction: React.FC<DetailHeaderIconActionProps> = ({
  label,
  icon,
  onClick,
  testId,
  disabled = false,
}) => (
  <ToolbarTooltip label={label} position="bottom-end">
    <Button
      htmlType="button"
      variant="tertiary"
      size="small"
      iconOnly
      icon={icon}
      aria-label={label}
      onClick={onClick}
      data-testid={testId}
      disabled={disabled}
    />
  </ToolbarTooltip>
);

export default DetailHeaderIconAction;
