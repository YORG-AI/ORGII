import { MoreHorizontal } from "lucide-react";
import React from "react";

import type { NavigationMenuItem } from "../config";

interface NavigationMenuRowActionButtonProps {
  icon?: NavigationMenuItem["rowActionIcon"];
  label: string;
  active?: boolean;
  dataTestId?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function NavigationMenuRowActionButton({
  icon,
  label,
  active,
  dataTestId,
  onClick,
}: NavigationMenuRowActionButtonProps): React.ReactElement {
  const RowActionIcon = icon ?? MoreHorizontal;

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid={dataTestId}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors duration-150 hover:bg-sidebar-selected hover:text-text-1 focus:outline-none ${
        active ? "text-text-1" : "text-text-3"
      }`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      }}
    >
      {React.createElement(RowActionIcon, {
        size: 14,
        strokeWidth: icon ? 2 : 1.75,
      })}
    </button>
  );
}
