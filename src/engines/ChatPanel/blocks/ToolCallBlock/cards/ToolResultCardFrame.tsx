import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";

import { classNames } from "@src/util/ui/classNames";

const CARD_FRAME_BASE =
  "mx-3 my-2 rounded-lg border border-fill-4 bg-fill-2 transition-colors";
const CARD_FRAME_PADDED = "px-3 py-2.5";

interface ToolResultCardFrameBaseProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  hoverable?: boolean;
}

type ToolResultCardFrameProps = ToolResultCardFrameBaseProps &
  HTMLAttributes<HTMLDivElement>;

type ToolResultCardFrameLinkProps = ToolResultCardFrameBaseProps &
  AnchorHTMLAttributes<HTMLAnchorElement>;

type ToolResultCardFrameButtonProps = ToolResultCardFrameBaseProps &
  ButtonHTMLAttributes<HTMLButtonElement>;

export function ToolResultCardFrame({
  children,
  className,
  padded = true,
  hoverable = true,
  ...props
}: ToolResultCardFrameProps) {
  return (
    <div
      className={classNames(
        CARD_FRAME_BASE,
        hoverable && "hover:bg-fill-3",
        padded && CARD_FRAME_PADDED,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ToolResultCardFrameLink({
  children,
  className,
  padded = true,
  hoverable = true,
  ...props
}: ToolResultCardFrameLinkProps) {
  return (
    <a
      className={classNames(
        CARD_FRAME_BASE,
        hoverable && "hover:bg-fill-3",
        padded && CARD_FRAME_PADDED,
        className
      )}
      {...props}
    >
      {children}
    </a>
  );
}

export function ToolResultCardFrameButton({
  children,
  className,
  padded = true,
  hoverable = true,
  type = "button",
  ...props
}: ToolResultCardFrameButtonProps) {
  return (
    <button
      type={type}
      className={classNames(
        CARD_FRAME_BASE,
        "block w-[calc(100%-1.5rem)] text-left focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:outline-none",
        hoverable && "cursor-pointer hover:bg-fill-3",
        padded && CARD_FRAME_PADDED,
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
