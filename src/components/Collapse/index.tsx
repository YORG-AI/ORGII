/**
 * Collapse Component
 *
 * Native accordion/collapse with clean styling.
 *
 * Features:
 * - Accordion mode (single panel open)
 * - Multiple panels open
 * - Custom headers
 * - Icons support
 * - Smooth animations
 * - Controlled/uncontrolled modes
 * - Nested collapse
 * - Disabled panels
 *
 * @example
 * ```tsx
 * import Collapse from "@src/components/Collapse";
 *
 * <Collapse defaultActiveKey={['1']} accordion>
 *   <Collapse.Item
 *     key="1"
 *     header="Panel 1"
 *     extra={<button>Extra</button>}
 *   >
 *     Content 1
 *   </Collapse.Item>
 *   <Collapse.Item key="2" header="Panel 2">
 *     Content 2
 *   </Collapse.Item>
 * </Collapse>
 * ```
 */
import React, {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import "./index.scss";

// Collapse Context
interface CollapseContextValue {
  activeKeys: string[];
  accordion?: boolean;
  onChange?: (key: string) => void;
}

const CollapseContext = createContext<CollapseContextValue | undefined>(
  undefined
);

export interface CollapseItemProps {
  /**
   * Panel key (unique identifier)
   */
  key: string;

  /**
   * Panel header
   */
  header: React.ReactNode;

  /**
   * Extra content in header
   */
  extra?: React.ReactNode;

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Show arrow icon
   * @default true
   */
  showArrow?: boolean;

  /**
   * Custom expand icon
   */
  expandIcon?: React.ReactNode;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Children (panel content)
   */
  children?: React.ReactNode;
}

const CollapseItem: React.FC<CollapseItemProps> = ({
  header,
  extra,
  disabled = false,
  showArrow = true,
  expandIcon,
  className = "",
  style,
  children,
}) => {
  const { isDark } = useCurrentTheme();
  const context = useContext(CollapseContext);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number>(0);

  // Get key from props (passed by React.Children)
  const key = (children as { key?: string })?.key || "";
  const isActive = context?.activeKeys.includes(key) || false;

  // Measure content height for animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [children, isActive]);

  const handleClick = useCallback(() => {
    if (disabled) return;
    context?.onChange?.(key);
  }, [disabled, key, context]);

  const itemClasses = [
    "collapse-item",
    isActive && "collapse-item-active",
    disabled && "collapse-item-disabled",
    isDark && "collapse-item-dark",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={itemClasses} style={style}>
      <div
        className="collapse-header select-none"
        onClick={handleClick}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={isActive}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleClick();
          }
        }}
      >
        {showArrow && (
          <span className="collapse-arrow">
            {expandIcon ||
              (isActive ? (
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="chevron-down"
                  size={16}
                />
              ) : (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
                  size={16}
                />
              ))}
          </span>
        )}
        <span className="collapse-header-content">{header}</span>
        {extra && <span className="collapse-extra">{extra}</span>}
      </div>
      <div
        className="collapse-content-wrapper"
        style={{
          height: isActive ? `${contentHeight}px` : 0,
        }}
      >
        <div ref={contentRef} className="collapse-content">
          {children}
        </div>
      </div>
    </div>
  );
};

export interface CollapseProps {
  /**
   * Active panel keys (controlled)
   */
  activeKey?: string | string[];

  /**
   * Default active panel keys (uncontrolled)
   */
  defaultActiveKey?: string | string[];

  /**
   * Change callback
   */
  onChange?: (key: string | string[]) => void;

  /**
   * Accordion mode (only one panel open at a time)
   * @default false
   */
  accordion?: boolean;

  /**
   * Expand icon position
   * @default 'left'
   */
  expandIconPosition?: "left" | "right";

  /**
   * Bordered style
   * @default true
   */
  bordered?: boolean;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Children (CollapseItem components)
   */
  children?: React.ReactNode;
}

const Collapse: React.FC<CollapseProps> & {
  Item: typeof CollapseItem;
} = ({
  activeKey: controlledActiveKey,
  defaultActiveKey = [],
  onChange,
  accordion = false,
  expandIconPosition = "left",
  bordered = true,
  className = "",
  style,
  children,
}) => {
  const { isDark } = useCurrentTheme();

  // Normalize keys to array
  const normalizeKeys = (keys: string | string[] | undefined): string[] => {
    if (keys === undefined) return [];
    return Array.isArray(keys) ? keys : [keys];
  };

  const [internalActiveKeys, setInternalActiveKeys] = useState<string[]>(
    normalizeKeys(defaultActiveKey)
  );

  const activeKeys =
    controlledActiveKey !== undefined
      ? normalizeKeys(controlledActiveKey)
      : internalActiveKeys;

  const handleItemChange = useCallback(
    (key: string) => {
      let newActiveKeys: string[];

      if (accordion) {
        // Accordion mode: toggle single panel
        newActiveKeys = activeKeys.includes(key) ? [] : [key];
      } else {
        // Multiple mode: toggle panel in array
        newActiveKeys = activeKeys.includes(key)
          ? activeKeys.filter((activeKey) => activeKey !== key)
          : [...activeKeys, key];
      }

      if (controlledActiveKey === undefined) {
        setInternalActiveKeys(newActiveKeys);
      }

      onChange?.(accordion ? newActiveKeys[0] || "" : newActiveKeys);
    },
    [activeKeys, accordion, controlledActiveKey, onChange]
  );

  const contextValue: CollapseContextValue = useMemo(
    () => ({
      activeKeys,
      accordion,
      onChange: handleItemChange,
    }),
    [activeKeys, accordion, handleItemChange]
  );

  const collapseClasses = [
    "collapse",
    `collapse-icon-${expandIconPosition}`,
    bordered && "collapse-bordered",
    isDark && "collapse-dark",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Clone children to pass key prop
  const items = Children.map(children, (child, index) => {
    if (!isValidElement<CollapseItemProps>(child)) return child;

    const itemKey = child.props.key || child.key || String(index);
    return React.cloneElement(child, {
      ...child.props,
      key: itemKey,
    } as React.HTMLAttributes<HTMLElement>);
  });

  return (
    <CollapseContext.Provider value={contextValue}>
      <div className={collapseClasses} style={style}>
        {items}
      </div>
    </CollapseContext.Provider>
  );
};

Collapse.Item = CollapseItem;

export default Collapse;
