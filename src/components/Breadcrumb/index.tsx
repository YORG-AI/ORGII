/**
 * Breadcrumb Component
 *
 * Native breadcrumb navigation component.
 * Supports both items prop and Breadcrumb.Item children patterns.
 *
 * Features:
 * - API compatibility (Breadcrumb.Item children)
 * - Custom separator support
 * - maxCount for truncation
 * - Navigation support
 * - Custom styling
 *
 * @example
 * ```tsx
 * import Breadcrumb from "@src/components/Breadcrumb";
 *
 * // Using items prop (backward compatible)
 * <Breadcrumb items={[
 *   { label: "Home", link: "/" },
 *   { label: "Page" }
 * ]} />
 *
 * // Using Breadcrumb.Item (Native)
 * <Breadcrumb separator="/">
 *   <Breadcrumb.Item>Home</Breadcrumb.Item>
 *   <Breadcrumb.Item>Page</Breadcrumb.Item>
 * </Breadcrumb>
 * ```
 */
import React, { Children, ReactNode, isValidElement } from "react";
import { useNavigate } from "react-router-dom";

import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

interface BreadcrumbItem {
  label: string;
  link?: string;
  active?: boolean;
  viewMode?: "dashboard" | "table";
  callback?: () => void;
  icon?: React.ReactNode;
}

interface BreadcrumbProps {
  /**
   * Breadcrumb items (for backward compatibility)
   */
  items?: BreadcrumbItem[];

  /**
   * Whether the final item should be emphasized as the current location.
   * @default true
   */
  emphasizeLast?: boolean;

  /**
   * Custom separator (ReactNode)
   * @default ChevronRight icon
   */
  separator?: ReactNode;

  /**
   * Maximum number of items to show (truncate with ellipsis)
   */
  maxCount?: number;

  /**
   * Additional className
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Children (Breadcrumb.Item components)
   */
  children?: ReactNode;
}

interface BreadcrumbItemProps {
  /**
   * Item content
   */
  children?: ReactNode;

  /**
   * Additional className
   */
  className?: string;

  /**
   * Click handler
   */
  onClick?: () => void;

  /**
   * Link to navigate to
   */
  href?: string;
}

const BreadcrumbItemComponent: React.FC<BreadcrumbItemProps> = ({
  children,
  className = "",
  onClick,
  href,
}) => {
  const navigate = useNavigate();

  const handleClick = () => {
    if (href) {
      navigate(href);
    } else if (onClick) {
      onClick();
    }
  };

  const isClickable = href || onClick;

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap text-[14px] text-text-2 transition-colors ${isClickable ? "active:bg-bg-4 cursor-pointer rounded-full px-2 py-1 hover:bg-bg-3 hover:text-text-1" : ""} ${className}`}
      onClick={isClickable ? handleClick : undefined}
    >
      {children}
    </span>
  );
};

const Breadcrumb: React.FC<BreadcrumbProps> & {
  Item: React.FC<BreadcrumbItemProps>;
} = ({
  items,
  separator,
  maxCount,
  className = "",
  style,
  children,
  emphasizeLast = true,
}) => {
  const navigate = useNavigate();

  // Default separator
  const defaultSeparator =
    separator !== undefined ? (
      separator
    ) : (
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        data-icon="chevron-right"
        size={14}
        strokeWidth={1.75}
        className="text-fill-4"
      />
    );

  // If using items prop (backward compatible)
  if (items && items.length > 0) {
    const displayItems =
      maxCount && items.length > maxCount
        ? [
            ...items.slice(0, 1),
            { label: "..." } as BreadcrumbItem,
            ...items.slice(items.length - maxCount + 1),
          ]
        : items;

    return (
      <div
        className={`flex flex-wrap items-center gap-2 ${className}`}
        style={style}
      >
        {displayItems.map((item, index) => {
          const isLast = index === displayItems.length - 1;

          const isClickable = !isLast && (item.link || item.callback);

          return (
            <React.Fragment key={index}>
              <span
                className={`inline-flex items-center whitespace-nowrap text-[14px] transition-colors ${
                  isLast && emphasizeLast
                    ? "font-medium text-text-1"
                    : isClickable
                      ? "active:bg-bg-4 cursor-pointer rounded-full px-2 py-1 text-text-2 hover:bg-bg-3 hover:text-text-1"
                      : "text-text-2"
                }`}
                onClick={
                  isClickable
                    ? () => {
                        if (item.link) {
                          navigate(item.link, {
                            state: { viewMode: item.viewMode },
                          });
                        } else if (item.callback) {
                          item.callback();
                        }
                      }
                    : undefined
                }
              >
                {item.icon && (
                  <span className="mr-2 inline-flex items-center">
                    {item.icon}
                  </span>
                )}
                {item.label}
              </span>

              {!isLast && (
                <span className="flex flex-shrink-0 items-center text-fill-4">
                  {defaultSeparator}
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  // If using Breadcrumb.Item children (Native)
  if (children) {
    const childArray = Children.toArray(children).filter(
      (child) => isValidElement(child) && child.type === BreadcrumbItemComponent
    ) as React.ReactElement<BreadcrumbItemProps>[];

    if (childArray.length === 0) {
      return null;
    }

    // Apply maxCount truncation
    let displayChildren = childArray;
    if (maxCount && childArray.length > maxCount) {
      const first = childArray[0];
      const last = childArray.slice(-maxCount + 1);
      displayChildren = [
        first,
        <BreadcrumbItemComponent
          key="ellipsis"
          className="breadcrumb-item-ellipsis"
        >
          ...
        </BreadcrumbItemComponent>,
        ...last,
      ] as React.ReactElement<BreadcrumbItemProps>[];
    }

    return (
      <div
        className={`flex flex-wrap items-center gap-2 ${className}`}
        style={style}
      >
        {displayChildren.map((child, index) => {
          const isLast = index === displayChildren.length - 1;

          return (
            <React.Fragment key={child.key || index}>
              {React.cloneElement(child, {
                className: `${child.props.className || ""} ${isLast && emphasizeLast ? "font-medium text-text-1" : ""}`,
              })}
              {!isLast && (
                <span className="flex flex-shrink-0 items-center text-fill-4">
                  {defaultSeparator}
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  return null;
};

Breadcrumb.Item = BreadcrumbItemComponent;

export default Breadcrumb;
export type { BreadcrumbProps, BreadcrumbItemProps, BreadcrumbItem };
