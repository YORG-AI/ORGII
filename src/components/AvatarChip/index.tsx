import { memo } from "react";
import type { MouseEventHandler, ReactNode } from "react";

import PersonAvatar from "@src/components/PersonAvatar";

type AvatarChipVariant = "display" | "selectable";
type AvatarChipSize = "xs" | "sm";

interface AvatarChipProps {
  /** Person the chip names. Seeds the avatar's initial and identity colour. */
  avatarName: string;
  avatarSrc?: string;
  avatarSize?: number;
  label: ReactNode;
  variant?: AvatarChipVariant;
  size?: AvatarChipSize;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

const ROOT_CLASS = "inline-flex min-w-0 items-center gap-1";
const BUTTON_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30 disabled:cursor-not-allowed disabled:opacity-50";
const DISPLAY_CLASS = "rounded-full bg-fill-2 text-text-2";
const SELECTABLE_SELECTED_CLASS = "rounded bg-primary-1 text-primary-6";
const SELECTABLE_IDLE_CLASS = "rounded text-text-2 transition-colors";

const SIZE_CLASSES: Record<AvatarChipSize, string> = {
  xs: "px-1.5 py-[2px] text-[11px]",
  sm: "px-1.5 py-0.5 text-[12px]",
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function getVisualClassName(
  variant: AvatarChipVariant,
  selected: boolean,
  disabled: boolean
): string {
  if (variant === "display") {
    return DISPLAY_CLASS;
  }

  if (selected) {
    return SELECTABLE_SELECTED_CLASS;
  }

  return cx(SELECTABLE_IDLE_CLASS, !disabled && "hover:bg-fill-2");
}

const AvatarChip = memo(function AvatarChip({
  avatarName,
  avatarSrc,
  avatarSize = 14,
  label,
  variant = "display",
  size = "sm",
  selected = false,
  disabled = false,
  className,
  labelClassName,
  onClick,
}: AvatarChipProps) {
  const visualClassName = getVisualClassName(variant, selected, disabled);
  const rootClassName = cx(
    ROOT_CLASS,
    SIZE_CLASSES[size],
    visualClassName,
    className
  );
  const labelClass = cx("min-w-0 truncate", labelClassName);

  const content = (
    <>
      <PersonAvatar size={avatarSize} name={avatarName} src={avatarSrc} />
      <span className={labelClass}>{label}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-pressed={variant === "selectable" ? selected : undefined}
        onClick={onClick}
        className={cx(rootClassName, BUTTON_CLASS)}
      >
        {content}
      </button>
    );
  }

  return <span className={rootClassName}>{content}</span>;
});

AvatarChip.displayName = "AvatarChip";

export default AvatarChip;
