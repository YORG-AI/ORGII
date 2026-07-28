import React from "react";

import Switch from "@src/components/Switch";
import TabPill from "@src/components/TabPill";

export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <span className="text-[11px] font-medium uppercase tracking-wider text-primary-6">
    {children}
  </span>
);

export type SwitchRowLabelVariant = "dense" | "select";

const switchRowLabelClasses: Record<SwitchRowLabelVariant, string> = {
  dense: "text-[13px] text-text-2",
  /** Readable like form controls but smaller than default Select (12px / text-1). */
  select: "text-[12px] leading-[1.35] text-text-1",
};

export const SwitchRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** `select` — 12px text-1, between dense rows and full Select trigger. */
  labelVariant?: SwitchRowLabelVariant;
}> = ({ label, checked, onChange, labelVariant = "dense" }) => (
  <div className="flex min-h-[26px] items-center justify-between gap-2">
    <span className={switchRowLabelClasses[labelVariant]}>{label}</span>
    <Switch checked={checked} onChange={onChange} size="small" />
  </div>
);

export const SidebarPositionToggleRow: React.FC<{
  label: string;
  position: "left" | "right";
  leftLabel: string;
  rightLabel: string;
  onChange: (position: "left" | "right") => void;
  labelVariant?: SwitchRowLabelVariant;
}> = ({
  label,
  position,
  leftLabel,
  rightLabel,
  onChange,
  labelVariant = "dense",
}) => (
  <div className="flex min-h-[28px] items-center justify-between gap-2">
    <span className={switchRowLabelClasses[labelVariant]}>{label}</span>
    <TabPill
      tabs={[
        { key: "left", label: leftLabel },
        { key: "right", label: rightLabel },
      ]}
      activeTab={position}
      onChange={(key) => onChange(key as "left" | "right")}
      variant="pill"
      size="default"
      fillWidth={false}
      colorScheme="layout"
      className="shrink-0"
    />
  </div>
);

export const LayoutMethodToggleRow: React.FC<{
  label: string;
  value: "compact" | "comfort";
  compactLabel: string;
  comfortLabel: string;
  onChange: (value: "compact" | "comfort") => void;
  labelVariant?: SwitchRowLabelVariant;
}> = ({
  label,
  value,
  compactLabel,
  comfortLabel,
  onChange,
  labelVariant = "dense",
}) => (
  <div className="flex min-h-[28px] items-center justify-between gap-2">
    <span className={switchRowLabelClasses[labelVariant]}>{label}</span>
    <TabPill
      tabs={[
        { key: "comfort", label: comfortLabel },
        { key: "compact", label: compactLabel },
      ]}
      activeTab={value}
      onChange={(key) => onChange(key as "compact" | "comfort")}
      variant="pill"
      size="default"
      fillWidth={false}
      colorScheme="layout"
      className="shrink-0"
    />
  </div>
);

export function TwoOptionToggleRow<TValue extends string>({
  label,
  value,
  options,
  onChange,
  labelVariant = "dense",
}: {
  label: string;
  value: TValue;
  options: [{ key: TValue; label: string }, { key: TValue; label: string }];
  onChange: (value: TValue) => void;
  labelVariant?: SwitchRowLabelVariant;
}) {
  return (
    <div className="flex min-h-[28px] items-center justify-between gap-2">
      <span className={switchRowLabelClasses[labelVariant]}>{label}</span>
      <TabPill
        tabs={options}
        activeTab={value}
        onChange={(key) => onChange(key as TValue)}
        variant="pill"
        size="default"
        fillWidth={false}
        colorScheme="layout"
        className="shrink-0"
      />
    </div>
  );
}

export type LayoutPresetCaptionSize = "thumbnail" | "body";

const layoutPresetCaptionClasses: Record<
  LayoutPresetCaptionSize,
  { base: string; active: string; inactive: string }
> = {
  thumbnail: {
    base: "leading-tight",
    active: "text-[10px] font-medium text-primary-6",
    inactive: "text-[10px] text-text-3",
  },
  body: {
    base: "text-[12px] leading-[1.35]",
    active: "font-medium text-primary-6",
    inactive: "font-normal text-text-1",
  },
};

export const LayoutPresetOption: React.FC<{
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /**
   * `thumbnail` — small caption under grid thumbs (toolbar dropdown).
   * `body` — 12px body text under thumbs (settings rows), smaller than Select trigger.
   */
  captionSize?: LayoutPresetCaptionSize;
  stretch?: boolean;
}> = ({
  active,
  label,
  onClick,
  children,
  captionSize = "thumbnail",
  stretch = true,
}) => {
  const caption = layoutPresetCaptionClasses[captionSize];
  const sizingClass = stretch ? "min-w-0 flex-1" : "w-fit min-w-[92px]";
  return (
    <button
      type="button"
      className={`flex ${sizingClass} flex-col items-center gap-1.5 rounded-lg border bg-workstation-bg px-1 py-1.5 transition-[border-color,box-shadow] duration-150 focus-visible:outline-none ${
        active
          ? "border-primary-6 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]"
          : "border-border-2 hover:border-border-3 focus-visible:border-primary-6 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]"
      }`}
      onClick={onClick}
    >
      <div className="rounded-md">{children}</div>
      <span
        className={`${caption.base} ${active ? caption.active : caption.inactive}`}
      >
        {label}
      </span>
    </button>
  );
};
