import { Search } from "lucide-react";
import React from "react";

import Input from "@src/components/Input";

interface SidebarMenuSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
}

/** Shared ghost search field used around navigation sidebar menu content. */
const SidebarMenuSearchInput: React.FC<SidebarMenuSearchInputProps> =
  React.memo(({ value, onChange, placeholder, compact = false }) => {
    const height = compact ? 28 : 36;

    return (
      <Input
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        borderless
        bgless
        autoHeight
        allowClear
        prefix={<Search size={14} strokeWidth={2} className="text-text-3" />}
        className={`${compact ? "h-7 [&_.input-inner]:!h-7" : "h-9 [&_.input-inner]:!h-9"} rounded-lg text-text-1 [&_.input-inner]:gap-3 [&_.input-inner]:!px-2 [&_.input-prefix]:mr-0`}
        inputClassName={`${compact ? "text-[12px]" : "text-[13px]"} font-normal placeholder:text-text-3`}
        style={{ height }}
        inputStyle={{ transform: "none" }}
      />
    );
  });

SidebarMenuSearchInput.displayName = "SidebarMenuSearchInput";

export default SidebarMenuSearchInput;
