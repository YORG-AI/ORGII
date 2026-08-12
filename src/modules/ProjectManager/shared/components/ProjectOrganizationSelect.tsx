import { Network } from "lucide-react";
import type { FC, ReactNode } from "react";

import Select from "@src/components/Select";
import type { SelectOption, SelectProps } from "@src/components/Select";
import { WorkstationTrailSurface } from "@src/modules/shared/layouts/blocks";

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
 * Project-organization picker with Workstation-trail typography inside the
 * shared floating trail surface.
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
  <WorkstationTrailSurface className="flex !w-fit max-w-[220px]">
    <Select
      value={value}
      options={options}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      loading={loading}
      size="small"
      variant="ghost"
      prefix={<Network size={14} strokeWidth={1.75} />}
      showSearch
      dropdownWidthMode="min-match"
      dropdownMinWidth={220}
      panelZIndex={10000}
      placement={placement}
      dataTestId={dataTestId}
      ariaLabel={ariaLabel}
      className="w-auto max-w-full [&_.select-prefix]:!text-text-2 [&_.select-selector]:!h-6 [&_.select-selector]:!px-1 [&_.select-selector]:!text-[13px] [&_.select-selector]:!font-medium"
    />
  </WorkstationTrailSurface>
);

ProjectOrganizationSelect.displayName = "ProjectOrganizationSelect";

export default ProjectOrganizationSelect;
