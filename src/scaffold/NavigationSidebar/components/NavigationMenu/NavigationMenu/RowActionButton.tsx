import React from "react";

import AnyIcon from "@src/components/AnyIcon";
import { MoreHorizontalIcon } from "@src/icons";

import type { NavigationMenuItem } from "../config";

interface NavigationMenuRowActionButtonProps {
  icon?: NavigationMenuItem["rowActionIcon"];
  dataIcon?: string;
  iconClassName?: string;
  label: string;
  active?: boolean;
  dataTestId?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function NavigationMenuRowActionButton({
  icon,
  dataIcon,
  iconClassName,
  label,
  active,
  dataTestId,
  onClick,
}: NavigationMenuRowActionButtonProps): React.ReactElement {
  const RowActionIcon = icon ?? MoreHorizontalIcon;

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid={dataTestId}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors duration-150 hover:bg-sidebar-selected hover:text-text-1 focus:outline-none ${active ? "bg-sidebar-selected text-text-1" : "text-text-2"}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      }}
    >
      <AnyIcon
        icon={RowActionIcon}
        data-icon={dataIcon ?? (icon ? undefined : "ellipsis")}
        size={14}
        strokeWidth={icon ? 2 : 1.75}
        className={iconClassName}
      />
    </button>
  );
}
