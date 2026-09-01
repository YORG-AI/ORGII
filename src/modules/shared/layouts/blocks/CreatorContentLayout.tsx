import { useAtomValue } from "jotai";
import type { CSSProperties, ReactNode } from "react";

import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { CREATOR_COMPOSER_POSITION } from "@src/config/sessionCreatorConfig";
import { creatorComposerPositionAtom } from "@src/store/session/creatorComposerPositionAtom";

/**
 * Keep creator hero content slightly above center while reserving enough room
 * for the docked composer and its action rows on shorter windows.
 */
export const CREATOR_MIDDLE_POSITION_STYLE: CSSProperties = {
  top: "clamp(9rem, 42%, calc(100% - 20rem))",
};

/**
 * Keep every launchpad composer the same distance from the bottom edge.
 */
export const CREATOR_BOTTOM_DOCK_PADDING_CLASS = `${COMPOSER_BOTTOM_DOCK_PADDING_CLASS} pt-4`;

export interface CreatorContentLayoutProps {
  children?: ReactNode;
  contentDataTestId?: string;
  middleContent?: ReactNode;
  placement: "bottom" | "fill";
}

/**
 * Shared page geometry for Session, Work Item, and Project creators.
 * Agent launchers fill the page and own their geometry; manual composers share
 * the saved Bottom/Middle preference without changing the editor's ancestry.
 */
export default function CreatorContentLayout({
  children,
  contentDataTestId,
  middleContent,
  placement,
}: CreatorContentLayoutProps) {
  const composerPosition = useAtomValue(creatorComposerPositionAtom);
  const isCenteredComposer =
    composerPosition === CREATOR_COMPOSER_POSITION.MIDDLE;
  if (placement === "fill") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div
          className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
          data-testid={contentDataTestId}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative flex h-full min-h-0 w-full flex-col ${
        isCenteredComposer ? "overflow-y-auto" : "overflow-hidden"
      }`}
      data-creator-composer-position={composerPosition}
    >
      <div
        className={
          isCenteredComposer
            ? `mt-auto flex shrink-0 items-center justify-center px-4 ${middleContent ? "pt-4" : ""}`
            : "absolute inset-x-0 flex -translate-y-1/2 items-center justify-center px-4"
        }
        style={isCenteredComposer ? undefined : CREATOR_MIDDLE_POSITION_STYLE}
      >
        {middleContent}
      </div>
      <div
        className={`relative z-10 ${isCenteredComposer ? "mb-auto" : "mt-auto"} flex w-full shrink-0 flex-col ${
          isCenteredComposer ? "py-4" : CREATOR_BOTTOM_DOCK_PADDING_CLASS
        }`}
        data-testid={contentDataTestId}
      >
        {children}
      </div>
    </div>
  );
}
