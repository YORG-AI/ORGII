import type { ReactNode } from "react";

export interface CreatorContentLayoutProps {
  centered?: boolean;
  centeredDataTestId?: string;
  children?: ReactNode;
}

/**
 * Shared fill-or-middle layout for Session, Work Item, and Project creators.
 * Centered content receives symmetric clearance so its visual midpoint remains
 * the midpoint of the available launcher area.
 */
export default function CreatorContentLayout({
  centered = false,
  centeredDataTestId,
  children,
}: CreatorContentLayoutProps) {
  return (
    <div
      className={`flex h-full min-h-0 w-full flex-col ${
        centered ? "overflow-y-auto" : "overflow-hidden"
      }`}
    >
      <div
        className={
          centered ? "my-auto flex w-full shrink-0 flex-col py-6" : "contents"
        }
        data-testid={centered ? centeredDataTestId : undefined}
      >
        {children}
      </div>
    </div>
  );
}
