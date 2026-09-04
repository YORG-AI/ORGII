import React, { useState } from "react";

import Button from "@src/components/Button";
import Tooltip from "@src/components/Tooltip";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";

import CollapsibleSection from "./CollapsibleSection";
import InlineInfoCard from "./InlineInfoCard";

export interface InlineOptionCardSection {
  key: string;
  title: string;
  content: React.ReactNode;
  defaultOpen?: boolean;
}

export interface InlineOptionCardProps {
  title?: React.ReactNode;
  countLabel?: React.ReactNode;
  description?: React.ReactNode;
  sections: InlineOptionCardSection[];
  className?: string;
  contentClassName?: string;
  hideSectionTitles?: boolean;
}

export function InlineOptionPill({
  label,
  selected,
  tooltip,
  onClick,
}: {
  label: React.ReactNode;
  selected: boolean;
  tooltip?: React.ReactNode;
  onClick?: () => void;
}) {
  const [suppressHover, setSuppressHover] = useState(false);

  const checkIcon = (
    <span
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
        selected
          ? "border-primary-6 bg-primary-6"
          : "border-border-3 bg-primary-container"
      }`}
    >
      {selected && (
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={10}
          className="text-white"
        />
      )}
    </span>
  );

  const pill = (
    <Button
      variant="secondary"
      appearance="outline"
      shape="round"
      size="small"
      icon={checkIcon}
      onClick={(event) => {
        event.currentTarget.blur();
        setSuppressHover(true);
        onClick?.();
      }}
      onMouseLeave={() => setSuppressHover(false)}
      className={`inline-flex! max-w-full! flex-row! items-center! gap-1.5! border-border-2 bg-fill-1 px-2.5 py-1 text-[12px] font-normal! text-text-2 ${
        suppressHover ? "hover:border-border-2!" : ""
      }`}
    >
      {label}
    </Button>
  );

  if (!tooltip) return pill;
  return (
    <Tooltip content={tooltip} position="top">
      {pill}
    </Tooltip>
  );
}

const InlineOptionCard: React.FC<InlineOptionCardProps> = ({
  title,
  countLabel,
  description,
  sections,
  className,
  contentClassName,
  hideSectionTitles = false,
}) => {
  const hasHeader = title != null || countLabel != null || description != null;

  return (
    <InlineInfoCard className={className} contentClassName={contentClassName}>
      <div className="flex min-w-0 flex-col gap-3">
        {hasHeader && (
          <>
            {(title != null || countLabel != null) && (
              <div className="flex min-w-0 items-center gap-1.5 text-xs">
                {title != null && (
                  <span className="truncate font-medium text-text-1">
                    {title}
                  </span>
                )}
                {title != null && countLabel != null && (
                  <span className="shrink-0 text-text-4">·</span>
                )}
                {countLabel != null && (
                  <span className="shrink-0 text-text-2">{countLabel}</span>
                )}
              </div>
            )}

            {description != null && (
              <p className="text-xs leading-5 whitespace-pre-line text-text-2">
                {description}
              </p>
            )}
          </>
        )}

        {sections.map((section, index) => (
          <div
            key={section.key}
            className={
              hasHeader || index > 0 ? "border-t border-border-2 pt-2" : ""
            }
          >
            {hideSectionTitles ? (
              <div>{section.content}</div>
            ) : (
              <CollapsibleSection
                title={section.title}
                defaultOpen={section.defaultOpen ?? true}
                compact
                headerRowClassName="min-h-7 py-0"
                titleButtonClassName="text-xs font-medium text-primary-6"
                titleClassName="text-xs font-medium text-primary-6"
                chevronSize={14}
                chevronClassName="text-primary-6"
              >
                <div className="ml-[14px] pl-1">{section.content}</div>
              </CollapsibleSection>
            )}
          </div>
        ))}
      </div>
    </InlineInfoCard>
  );
};

export default InlineOptionCard;
