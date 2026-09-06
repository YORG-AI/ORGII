import React from "react";

import type { ModelPickerStyle } from "@src/store/ui/chatPanel/displayPrefsAtoms";

import { DispatchCategoryDropdown } from "./DispatchCategoryDropdown";
import { DispatchCategoryPalette } from "./index";
import type { DispatchCategoryPaletteProps } from "./types";

export interface DispatchCategoryPickerProps extends DispatchCategoryPaletteProps {
  style: ModelPickerStyle;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: "top" | "bottom";
}

/**
 * Shared presentation switch for every Agent/runtime picker.
 *
 * New Session and an existing conversation must honor the same configured
 * dropdown/Spotlight choice. Keeping this switch beside the two canonical
 * picker implementations prevents composers from growing their own palette.
 */
export const DispatchCategoryPicker: React.FC<DispatchCategoryPickerProps> = ({
  style,
  anchorRef,
  placement,
  ...props
}) =>
  style === "dropdown" ? (
    <DispatchCategoryDropdown
      {...props}
      anchorRef={anchorRef}
      placement={placement}
    />
  ) : (
    <DispatchCategoryPalette {...props} />
  );
