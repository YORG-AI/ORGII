import { memo } from "react";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useRefreshSpin } from "@src/hooks/ui";
import { HugeiconsIcon, Refresh04Icon } from "@src/icons";

interface WorkManagementRefreshButtonProps {
  label: string;
  loading: boolean;
  onRefresh: () => void;
  dataTestId?: string;
}

/** Shared refresh action for every Work Management 36px header. */
export const WorkManagementRefreshButton = memo(
  ({
    label,
    loading,
    onRefresh,
    dataTestId,
  }: WorkManagementRefreshButtonProps) => {
    const { spinClass, handleClick } = useRefreshSpin(onRefresh, loading);

    return (
      <ToolbarTooltip label={label}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          disabled={Boolean(spinClass)}
          onClick={handleClick}
          aria-label={label}
          data-testid={dataTestId}
          icon={
            <HugeiconsIcon
              icon={Refresh04Icon}
              data-icon="refresh-cw"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={2}
              className={spinClass}
            />
          }
        />
      </ToolbarTooltip>
    );
  }
);

WorkManagementRefreshButton.displayName = "WorkManagementRefreshButton";
