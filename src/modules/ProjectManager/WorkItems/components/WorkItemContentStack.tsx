import type { ReactNode } from "react";

interface WorkItemContentStackProps {
  titleContent?: ReactNode;
  pathContent?: ReactNode;
  propertiesContent?: ReactNode;
  descriptionContent?: ReactNode;
  lowerContent?: ReactNode;
  className?: string;
  scrollable?: boolean;
  descriptionFlexible?: boolean;
  metaClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  lowerClassName?: string;
  separatorClassName?: string;
  showDividers?: boolean;
}

export default function WorkItemContentStack({
  titleContent,
  pathContent,
  propertiesContent,
  descriptionContent,
  lowerContent,
  className = "",
  scrollable = false,
  descriptionFlexible = false,
  metaClassName = "px-4 pb-2 pt-1",
  titleClassName = "px-4 py-2",
  descriptionClassName = "px-4 py-4",
  lowerClassName = "px-4 pt-4",
  separatorClassName = "px-4",
  showDividers = true,
}: WorkItemContentStackProps) {
  const scrollClassName = scrollable
    ? "overflow-y-auto scrollbar-hide"
    : "overflow-hidden";
  const hasMetaContent = Boolean(pathContent || propertiesContent);
  const hasTopSeparator = Boolean(titleContent || hasMetaContent);
  const descriptionLayoutClassName = descriptionFlexible
    ? "min-h-0 flex-1"
    : "shrink-0";

  const separator = (
    <div className={`shrink-0 ${separatorClassName}`.trim()} aria-hidden>
      <div className="border-t border-border-2" />
    </div>
  );

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${scrollClassName} ${className}`.trim()}
    >
      {titleContent ? (
        <div className={`shrink-0 ${titleClassName}`.trim()}>
          {titleContent}
        </div>
      ) : null}
      {showDividers && titleContent && hasMetaContent ? separator : null}
      {hasMetaContent ? (
        <div className={`shrink-0 ${metaClassName}`.trim()}>
          <div className="scrollbar-hide flex max-w-full min-w-0 items-center overflow-x-auto overflow-y-visible">
            {pathContent ? <div className="shrink-0">{pathContent}</div> : null}
            {showDividers && pathContent && propertiesContent ? (
              <div
                className="mx-2 h-4 shrink-0 border-l border-border-2"
                aria-hidden
              />
            ) : null}
            {propertiesContent ? (
              <div className="shrink-0">{propertiesContent}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      {showDividers && hasTopSeparator ? separator : null}
      {descriptionContent ? (
        <div
          className={`${descriptionLayoutClassName} ${descriptionClassName}`.trim()}
        >
          {descriptionContent}
        </div>
      ) : null}
      {lowerContent ? (
        <>
          {showDividers ? separator : null}
          <div className={`min-h-0 flex-1 ${lowerClassName}`.trim()}>
            {lowerContent}
          </div>
        </>
      ) : null}
    </div>
  );
}
