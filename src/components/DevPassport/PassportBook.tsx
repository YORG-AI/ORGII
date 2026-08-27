/**
 * DevPassport Book Component
 */
import { Code, Fingerprint } from "lucide-react";
import React, { useMemo, useState } from "react";

// File type icons for passport watermark
import GoIcon from "@src/assets/fileTypeIcons/go.svg";
import PythonIcon from "@src/assets/fileTypeIcons/python.svg";
import ReactIcon from "@src/assets/fileTypeIcons/react.svg";
import RustIcon from "@src/assets/fileTypeIcons/rust.svg";
import TsIcon from "@src/assets/fileTypeIcons/typescript.svg";

import Stamp from "./Stamp";
import type { PageContent, StampData, UserProfile } from "./types";

const WATERMARK_ICONS = [TsIcon, ReactIcon, PythonIcon, GoIcon, RustIcon];

type FlipDirection = "forward" | "backward";

interface FlipState {
  sheetIndex: number;
  direction: FlipDirection;
}

export function advanceFlipState(
  previous: FlipState,
  sheetIndex: number
): FlipState {
  if (previous.sheetIndex === sheetIndex) return previous;
  return {
    sheetIndex,
    direction: sheetIndex > previous.sheetIndex ? "forward" : "backward",
  };
}

interface PassportBookProps {
  user: UserProfile;
  pages: PageContent[];
  currentSheetIndex: number;
  onFlip: (index: number) => void;
  coverColor?: string;
}

const ProfilePage: React.FC<{ user: UserProfile }> = ({ user }) => (
  <div className="absolute inset-0 overflow-hidden shadow-[inset_10px_0_20px_rgba(0,0,0,0.1)]">
    {/* Solid opaque background */}
    <div className="absolute inset-0 bg-[#fdfbf7]"></div>

    {/* Programming language icons watermark - neat grid, rotated to match page */}
    <div className="pointer-events-none absolute inset-0 grid grid-cols-6 gap-6 overflow-hidden p-8 opacity-[0.08]">
      {Array.from({ length: 24 }).map((_, i) => {
        const IconComponent = WATERMARK_ICONS[i % WATERMARK_ICONS.length];
        return (
          <div key={i} className="flex items-center justify-center">
            <IconComponent
              className="h-8 w-8"
              style={{ transform: "rotate(-90deg)" }}
            />
          </div>
        );
      })}
    </div>

    {/* Content rotated -90deg for horizontal passport view */}
    <div
      className="absolute left-1/2 top-1/2 z-10 flex flex-col"
      style={{
        transform: "translate(-50%, -50%) rotate(-90deg)",
        width: "549px",
        height: "392px",
      }}
    >
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b-2 border-slate-300 px-5">
        <h2 className="text-base font-bold tracking-[0.2em] text-slate-700">
          UNITED CODING
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
            TYPE: P
          </span>
          {/* Passport chip symbol */}
          <div className="flex h-6 w-8 items-center justify-center rounded border border-slate-400">
            <div className="relative flex h-3 w-6 items-center">
              <div className="absolute left-0 h-[2px] w-1.5 bg-slate-400"></div>
              <div className="absolute left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-slate-400"></div>
              <div className="absolute right-0 h-[2px] w-1.5 bg-slate-400"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Main content - photo left, info right, top aligned */}
      <div className="flex flex-1 items-start gap-4 px-4 py-3">
        {/* Left: Larger square photo */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <div className="relative h-32 w-32 overflow-hidden rounded border border-slate-300 bg-slate-200 shadow-sm contrast-125 grayscale">
            <img
              src={user.avatarUrl}
              alt="User"
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-blue-500/10 mix-blend-overlay"></div>
          </div>
          <div className="flex items-center gap-1 text-[7px] text-slate-400">
            <Fingerprint size={9} />
            <span className="tracking-wide">BIOMETRIC</span>
          </div>
        </div>

        {/* Right: Info in 3 rows - top aligned with photo */}
        <div className="flex flex-1 flex-col gap-2">
          {/* Row 1: Surname + Given Name */}
          <div className="flex w-full gap-4">
            <div className="flex-1">
              <div className="text-[8px] font-semibold uppercase tracking-wide text-slate-400">
                Surname
              </div>
              <div className="text-sm font-bold uppercase text-slate-800">
                {user.name.split(" ").slice(-1)[0]}
              </div>
            </div>
            <div className="flex-1">
              <div className="text-[8px] font-semibold uppercase tracking-wide text-slate-400">
                Given Name
              </div>
              <div className="text-sm font-bold uppercase text-slate-800">
                {user.name.split(" ").slice(0, -1).join(" ") || "-"}
              </div>
            </div>
          </div>

          {/* Row 2: Affiliation + Member Since */}
          <div className="flex w-full gap-4">
            <div className="flex-1">
              <div className="text-[8px] font-semibold uppercase tracking-wide text-slate-400">
                Affiliation
              </div>
              <div className="text-sm font-bold uppercase text-slate-800">
                {user.role || "DEV_LAND"}
              </div>
            </div>
            <div className="flex-1">
              <div className="text-[8px] font-semibold uppercase tracking-wide text-slate-400">
                Member Since
              </div>
              <div className="text-sm font-bold uppercase text-slate-800">
                {user.memberSince}
              </div>
            </div>
          </div>

          {/* Row 3: ID Number - full width */}
          <div className="w-full">
            <div className="text-[8px] font-semibold uppercase tracking-wide text-slate-400">
              ID Number
            </div>
            <div className="text-sm font-bold uppercase tracking-widest text-slate-800">
              {user.idNumber}
            </div>
          </div>
        </div>
      </div>

      {/* MRZ footer - larger */}
      <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-4 font-mono text-[11px] leading-relaxed tracking-[0.2em] text-slate-600">
        P&lt;DEV&lt;{user.name.split(" ").slice(-1)[0].toUpperCase()}&lt;
        {user.name.split(" ").slice(0, -1).join("&lt;").toUpperCase() || "X"}
        &lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;
        <br />
        {user.idNumber}
        &lt;4DEV9001018M3012315&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;04
      </div>
    </div>
  </div>
);

const StampsPage: React.FC<{ stamps?: StampData[]; pageNum: number }> = ({
  stamps,
  pageNum,
}) => (
  <div className="relative h-full w-full overflow-hidden p-4 shadow-[inset_15px_0_20px_rgba(0,0,0,0.05)]">
    {/* Solid opaque background */}
    <div className="absolute inset-0 bg-[#fdfbf7]"></div>

    <div className="pointer-events-none absolute left-4 right-4 top-4 h-full opacity-10">
      <div className="h-full w-full rounded-lg border-2 border-dashed border-slate-400"></div>
    </div>

    <div className="relative z-10 mt-2 text-center text-[10px] uppercase tracking-[0.2em] text-slate-300">
      ACHIVEMENTS / MILESTONES
    </div>

    <div className="relative z-10 mt-2 h-[85%] w-full">
      {stamps?.map((stamp) => (
        <Stamp key={stamp.id} data={stamp} />
      ))}
    </div>

    <div className="absolute bottom-3 z-10 w-full text-center text-xs text-slate-400">
      Page {pageNum}
    </div>
  </div>
);

const CoverInner: React.FC<{
  type: "front" | "back";
  color?: string;
}> = ({ type, color = "#2d2520" }) => (
  <div className="absolute inset-0 overflow-hidden border-l-2 border-l-white/10">
    {/* Solid opaque background - use cover color */}
    <div className="absolute inset-0" style={{ backgroundColor: color }}></div>
    <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
    {/* Content rotated -90deg for horizontal view */}
    <div
      className="absolute left-1/2 top-1/2 z-10 flex items-center justify-center"
      style={{
        transform: "translate(-50%, -50%) rotate(-90deg)",
        width: "549px",
        height: "392px",
      }}
    >
      {type === "front" ? (
        <div className="text-center">
          <div className="mb-4 flex justify-center">
            <Code className="text-white/40" size={48} />
          </div>
          <h3 className="max-w-md font-serif text-base uppercase leading-relaxed tracking-widest text-white/50">
            With great power comes great responsibility
          </h3>
        </div>
      ) : (
        <div className="text-center">
          <h3 className="mb-4 font-serif text-sm uppercase tracking-widest text-white/50">
            Official Notes
          </h3>
          <div className="h-32 w-64 rounded border border-white/20"></div>
        </div>
      )}
    </div>
  </div>
);

const CoverOuter: React.FC<{ type: "front" | "back"; color?: string }> = ({
  type,
  color = "#2d2520",
}) => (
  <div
    className={`relative flex h-full w-full flex-col items-center text-yellow-500/90 shadow-inner ${type === "front" ? "justify-center" : "justify-end pb-12"}`}
  >
    {/* Solid opaque background - use cover color */}
    <div className="absolute inset-0" style={{ backgroundColor: color }}></div>
    <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/black-leather.png')] opacity-40 mix-blend-overlay"></div>

    {type === "front" && (
      <div className="flex h-3/4 flex-col items-center justify-between py-10">
        <div className="relative z-10 text-center font-serif text-lg font-bold tracking-[0.2em]">
          UNITED CODING
        </div>

        <div className="relative z-10 flex flex-col items-center gap-6">
          <div className="relative flex h-24 w-24 items-center justify-center rounded-full border-[3px] border-yellow-500/60">
            <div className="absolute inset-1 rounded-full border border-yellow-500/30"></div>
            <Code size={40} strokeWidth={1.5} />
          </div>

          <div className="text-center">
            <div className="font-serif text-4xl font-bold tracking-[0.1em]">
              PASSPORT
            </div>
          </div>
        </div>

        <div className="relative z-10 flex flex-col items-center gap-2 opacity-70">
          <div className="max-w-[200px] text-center text-[6px] uppercase leading-tight tracking-widest opacity-80 md:text-[8px]">
            This passport verifies the property of the developer community
          </div>
          <div className="mt-4 flex h-6 w-10 items-center justify-center rounded-[4px] border border-yellow-500/80">
            <div className="h-6 w-6 scale-50 rounded-full border border-yellow-500/80"></div>
          </div>
        </div>
      </div>
    )}
    {type === "back" && (
      <div className="relative z-10 text-[10px] tracking-widest opacity-50">
        With great power comes great responsibility.
      </div>
    )}
  </div>
);

export const PassportBook: React.FC<PassportBookProps> = ({
  user,
  pages,
  currentSheetIndex,
  onFlip,
  coverColor = "#2d2520",
}) => {
  const contentSheets = useMemo(() => {
    const sheets = [];
    for (let index = 0; index < pages.length; index += 2) {
      sheets.push({
        front: pages[index],
        back: pages[index + 1],
      });
    }
    return sheets;
  }, [pages]);

  const totalSheets = 1 + contentSheets.length + 1;

  // Direction is part of the prop transition itself. Adjust it during render
  // so the z-index is correct in the same commit as the new sheet index,
  // without a layout-effect render cascade.
  const [flipState, setFlipState] = useState<FlipState>(() => ({
    sheetIndex: currentSheetIndex,
    direction: "forward",
  }));
  const nextFlipState = advanceFlipState(flipState, currentSheetIndex);
  if (nextFlipState !== flipState) {
    setFlipState(nextFlipState);
  }
  const direction = nextFlipState.direction;

  const getSheetStyle = (index: number) => {
    const isOpen = index <= currentSheetIndex;
    const rotation = isOpen ? -180 : 0;

    // Z-index priority: The pages actively flipping (at boundary) must be on top
    const isAtBoundary =
      index === currentSheetIndex || index === currentSheetIndex + 1;
    let zIndex: number;

    if (isAtBoundary) {
      // Direction-dependent Z-indexing for boundary pages to prevent clipping
      if (direction === "forward") {
        // Forward flip (Right -> Left): Moving page is the one with lower index (top of right stack)
        // It needs higher Z than the static page below it (higher index)
        // Logic: Lower Index > Higher Index
        zIndex = totalSheets * 5 + (totalSheets - index);
      } else {
        // Backward flip (Left -> Right): Moving page is the one with higher index (top of left stack)
        // It needs higher Z than the static page below it (lower index)
        // Logic: Higher Index > Lower Index
        zIndex = totalSheets * 5 + index;
      }
    } else if (isOpen) {
      zIndex = totalSheets + index;
    } else {
      zIndex = totalSheets - index;
    }

    const translateZ = isOpen ? index * 2 : (totalSheets - index) * 2;

    return {
      transform: `rotateY(${rotation}deg) translateZ(${translateZ}px)`,
      zIndex: zIndex,
    };
  };

  // Helper to manage face visibility
  // We swap visibility exactly halfway through the 1s animation (0.5s)
  // when the page is at 90 degrees (invisible to user)
  const getFaceStyle = (
    sheetIndex: number,
    isFrontFace: boolean
  ): React.CSSProperties => {
    const isOpen = sheetIndex <= currentSheetIndex;
    // Front face is visible when closed (!isOpen)
    // Back face is visible when open (isOpen)
    const shouldShow = isFrontFace ? !isOpen : isOpen;

    return {
      opacity: shouldShow ? 1 : 0,
      // Wait 0.5s (half of 1s duration) before switching opacity
      // This ensures the content changes exactly when the page is edge-on
      transition: "opacity 0s 0.5s",
      pointerEvents: shouldShow ? "auto" : "none",
    };
  };

  // Back face needs rotation to appear correct when page is flipped
  const backFaceTransform: React.CSSProperties = {
    transform: "rotateY(180deg)",
  };

  // Rotate 90deg only when showing the first page (profile page)
  const shouldRotate = currentSheetIndex === 0;

  return (
    <div
      className="flex items-center justify-center"
      style={{
        // Square container to prevent shifting during rotation
        width: "560px",
        height: "560px",
      }}
    >
      <div
        className="perspective-1500 relative h-[480px] w-[340px] select-none transition-transform duration-700 ease-in-out md:h-[560px] md:w-[400px]"
        style={{
          transform: shouldRotate ? "rotate(90deg)" : "rotate(0deg)",
        }}
      >
        {/* Front Cover */}
        <div
          className="preserve-3d transform-origin-left page-flip-transition passport-sheet absolute inset-0 h-full w-full cursor-pointer"
          style={getSheetStyle(0)}
          onClick={() => (currentSheetIndex === -1 ? onFlip(0) : onFlip(-1))}
        >
          {/* Front face - Cover outer */}
          <div
            className="absolute inset-0 overflow-hidden border border-l-4 border-stone-800 border-l-stone-900 shadow-2xl"
            style={getFaceStyle(0, true)}
          >
            <CoverOuter type="front" color={coverColor} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 to-transparent mix-blend-overlay"></div>
          </div>
          {/* Back face - Cover inner */}
          <div
            className="absolute inset-0 overflow-hidden bg-[#fdfbf7]"
            style={{ ...backFaceTransform, ...getFaceStyle(0, false) }}
          >
            <CoverInner type="front" color={coverColor} />
          </div>
        </div>

        {/* Content Sheets - NO RADIUS */}
        {contentSheets.map((sheetContent, index) => {
          const sheetIndex = index + 1;

          return (
            <div
              key={`sheet-${sheetIndex}`}
              className="preserve-3d transform-origin-left page-flip-transition passport-sheet absolute left-0 top-[1%] h-[98%] w-[98%] cursor-pointer"
              style={getSheetStyle(sheetIndex)}
              onClick={() =>
                currentSheetIndex === sheetIndex - 1
                  ? onFlip(sheetIndex)
                  : onFlip(sheetIndex - 1)
              }
            >
              {/* Front face */}
              <div
                className="absolute inset-0 overflow-hidden border-l border-r-2 border-stone-200 border-r-stone-300 bg-[#fdfbf7]"
                style={getFaceStyle(sheetIndex, true)}
              >
                {sheetContent.front?.type === "profile" ? (
                  <ProfilePage user={user} />
                ) : sheetContent.front ? (
                  <StampsPage
                    stamps={sheetContent.front.stamps}
                    pageNum={index * 2 + 1}
                  />
                ) : (
                  <div className="h-full w-full bg-[#fdfbf7]"></div>
                )}
              </div>
              {/* Back face */}
              <div
                className="absolute inset-0 overflow-hidden border-l-2 border-r border-stone-200 border-l-stone-300 bg-[#fdfbf7]"
                style={{
                  ...backFaceTransform,
                  ...getFaceStyle(sheetIndex, false),
                }}
              >
                {sheetContent.back?.type === "profile" ? (
                  <ProfilePage user={user} />
                ) : sheetContent.back ? (
                  <StampsPage
                    stamps={sheetContent.back.stamps}
                    pageNum={index * 2 + 2}
                  />
                ) : (
                  <div className="h-full w-full bg-[#fdfbf7]"></div>
                )}
              </div>
            </div>
          );
        })}

        {/* Back Cover */}
        <div
          className="preserve-3d transform-origin-left page-flip-transition passport-sheet absolute inset-0 h-full w-full cursor-pointer"
          style={getSheetStyle(totalSheets - 1)}
          onClick={() =>
            currentSheetIndex === totalSheets - 2
              ? onFlip(totalSheets - 1)
              : onFlip(totalSheets - 2)
          }
        >
          {/* Front face - inner cover */}
          <div
            className="absolute inset-0 overflow-hidden border-l border-stone-200 bg-[#fdfbf7]"
            style={getFaceStyle(totalSheets - 1, true)}
          >
            <CoverInner type="back" color={coverColor} />
          </div>
          {/* Back face - outer cover */}
          <div
            className="absolute inset-0 overflow-hidden border border-r-4 border-stone-800 border-r-stone-900 shadow-2xl"
            style={{
              ...backFaceTransform,
              ...getFaceStyle(totalSheets - 1, false),
            }}
          >
            <CoverOuter type="back" color={coverColor} />
          </div>
        </div>

        {/* Book spine shadow - NO RADIUS on top/bottom, hidden when fully open */}
        <div
          className="translate-z-[-5px] absolute left-0 top-[1%] -z-10 h-[98%] w-[98%] transform bg-white shadow-xl transition-opacity duration-500"
          style={{
            opacity: currentSheetIndex >= totalSheets - 1 ? 0 : 1,
          }}
        ></div>
      </div>
    </div>
  );
};
