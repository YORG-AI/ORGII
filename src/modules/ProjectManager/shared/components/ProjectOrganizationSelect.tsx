import { Network } from "lucide-react";
import type { FC, ReactNode } from "react";

import Select from "@src/components/Select";
import type { SelectOption, SelectProps } from "@src/components/Select";

export interface ProjectOrganizationSelectProps {
  value: SelectProps["value"];
  options: SelectOption[];
  onChange: NonNullable<SelectProps["onChange"]>;
  placeholder: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  placement?: SelectProps["placement"];
  dataTestId?: string;
  ariaLabel?: string;
}

/**
 * Project-organization picker presented as a standard creator property pill.
 */
const ProjectOrganizationSelect: FC<ProjectOrganizationSelectProps> = ({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  loading = false,
  placement = "auto",
  dataTestId,
  ariaLabel = "Project organization",
}) => (
  <Select
    value={value}
    options={options}
    onChange={onChange}
    placeholder={placeholder}
    disabled={disabled}
    loading={loading}
    size="small"
    radius="pill"
    prefix={<Network size={14} strokeWidth={1.75} />}
    showSearch
    dropdownWidthMode="min-match"
    dropdownMinWidth={220}
    panelZIndex={10000}
    placement={placement}
    dataTestId={dataTestId}
    ariaLabel={ariaLabel}
    className="w-auto max-w-[220px]"
    selectorClassName="!h-7 !rounded-full !bg-bg-2 !px-3 !text-[13px] !font-medium !shadow-none [&_.select-prefix]:!text-text-2"
  />
);

ProjectOrganizationSelect.displayName = "ProjectOrganizationSelect";

export default ProjectOrganizationSelect;
