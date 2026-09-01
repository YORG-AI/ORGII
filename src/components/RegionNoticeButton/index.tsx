import React, { useCallback, useState } from "react";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { HugeiconsIcon, InternetIcon } from "@src/icons";

interface RegionNoticeButtonProps {
  title: string;
  body: React.ReactNode;
  className?: string;
  buttonClassName?: string;
  panelClassName?: string;
  alertClassName?: string;
  iconSize?: number;
  iconClassName?: string;
}

const RegionNoticeButton: React.FC<RegionNoticeButtonProps> = ({
  title,
  body,
  className = "",
  buttonClassName = "",
  panelClassName = "",
  alertClassName = "",
  iconSize = 16,
  iconClassName = "text-warning-6",
}) => {
  const [open, setOpen] = useState(false);

  const handleToggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <span className={`relative inline-flex ${className}`.trim()}>
      <Tooltip
        content={<KeyboardShortcutTooltipContent label={title} />}
        position="bottom-end"
        mouseEnterDelay={200}
        framedPanel
      >
        <span className="inline-flex">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={`${open ? "bg-fill-2!" : ""} ${buttonClassName}`.trim()}
            onClick={handleToggle}
            aria-label={title}
            aria-expanded={open}
            icon={
              <HugeiconsIcon
                icon={InternetIcon}
                data-icon="globe-2"
                size={iconSize}
                strokeWidth={2}
                className={iconClassName}
              />
            }
          />
        </span>
      </Tooltip>
      {open && (
        <span
          className={`absolute top-full right-0 z-30 mt-1 block w-[min(360px,calc(100vw-24px))] ${panelClassName}`.trim()}
        >
          <InlineAlert
            type="warning"
            title={title}
            hideIcon
            onClose={handleClose}
            className={alertClassName}
          >
            {body}
          </InlineAlert>
        </span>
      )}
    </span>
  );
};

export default RegionNoticeButton;
