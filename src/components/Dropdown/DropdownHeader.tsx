/**
 * DropdownHeader Component
 *
 * Reusable header for dropdown panels. Matches the shared row layout:
 * flex, items-center, gap-2, px-3, py-2, border-b.
 *
 * Use for:
 * - Back button + title (second layer panels)
 * - Section labels with optional actions
 *
 * @example
 * ```tsx
 * <DropdownHeader>
 *   <button onClick={onBack}><ArrowLeft /></button>
 *   <span className="text-[13px] font-medium">{title}</span>
 * </DropdownHeader>
 * ```
 */
import React from "react";

import { DROPDOWN_CLASSES } from "./tokens";

export interface DropdownHeaderProps {
  children: React.ReactNode;
}

const DropdownHeader: React.FC<DropdownHeaderProps> = ({ children }) => {
  return <div className={DROPDOWN_CLASSES.panelHeaderRow}>{children}</div>;
};

export default DropdownHeader;
