/**
 * PassportDisplay Component
 *
 * Reusable wrapper for PassportBook that handles:
 * - Rotation on first page (profile page viewed horizontally)
 * - Centering logic (centered when closed/first/last, expanded when middle pages)
 * - Stable container for rotation animations
 */
import React from "react";

import { PassportBook } from "./PassportBook";
import type { PageContent, UserProfile } from "./types";

interface PassportDisplayProps {
  user: UserProfile;
  pages: PageContent[];
  currentSheetIndex: number;
  onFlip: (index: number) => void;
  coverColor?: string;
}

export const PassportDisplay: React.FC<PassportDisplayProps> = ({
  user,
  pages,
  currentSheetIndex,
  onFlip,
  coverColor,
}) => {
  // Calculate total sheets: 1 (front cover) + ceil(pages/2) (content) + 1 (back cover)
  const totalContentSheets = Math.ceil(pages.length / 2);
  const lastSheetIndex = totalContentSheets + 1;

  // Expand container only when viewing middle pages (not first/last)
  const isMiddlePages =
    currentSheetIndex > 0 && currentSheetIndex < lastSheetIndex;

  return (
    <div className="flex items-center justify-center">
      {/* Centered container - expands when passport pages are open */}
      <div
        className="flex items-center justify-center transition-all duration-1000 ease-in-out"
        style={{
          width: isMiddlePages ? "800px" : "560px",
        }}
      >
        {/* Passport Book - offset when pages open so binding is centered */}
        <div
          className="transition-all duration-1000 ease-in-out"
          style={{
            marginLeft: isMiddlePages ? "400px" : "0px",
          }}
        >
          <PassportBook
            user={user}
            pages={pages}
            currentSheetIndex={currentSheetIndex}
            onFlip={onFlip}
            coverColor={coverColor}
          />
        </div>
      </div>
    </div>
  );
};

export default PassportDisplay;
