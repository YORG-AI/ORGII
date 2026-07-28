import React from "react";

interface DropdownTriggerWrapperProps {
  triggerRef: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
  enableKeyboard: boolean;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
}

const DropdownTriggerWrapper: React.FC<DropdownTriggerWrapperProps> = ({
  triggerRef,
  disabled,
  enableKeyboard,
  onClick,
  onKeyDown,
  onMouseEnter,
  onMouseLeave,
  children,
}) => {
  return (
    <div
      className="dropdown-trigger-wrapper relative inline-block"
      ref={triggerRef}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      {...(enableKeyboard ? { onKeyDown, tabIndex: 0 } : {})}
      style={{
        cursor: disabled ? "not-allowed" : "var(--interactive-cursor, default)",
      }}
    >
      {children}
    </div>
  );
};

export default DropdownTriggerWrapper;
