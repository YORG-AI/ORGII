import React from "react";

import { HugeiconsIcon, Tick01Icon } from "@src/icons";

import { DROPDOWN_ITEM } from "./tokens";

interface DropdownSelectedCheckProps {
  className?: string;
}

const DropdownSelectedCheck: React.FC<DropdownSelectedCheckProps> = ({
  className = "",
}) => (
  <HugeiconsIcon
    icon={Tick01Icon}
    data-icon="check"
    size={DROPDOWN_ITEM.iconSize}
    strokeWidth={2.25}
    className={["shrink-0 text-primary-6", className].filter(Boolean).join(" ")}
  />
);

export default DropdownSelectedCheck;
