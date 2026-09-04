/**
 * LaunchpadDashboardTiles — grid building blocks for the Launchpad dashboard.
 *
 * Houses the collapsible-section wrapper plus the tile-grid primitives
 * (wrap/layout, single tile, "add" tile, workspace card) shared across the
 * Launchpad dashboard's Workspaces / API keys / Agents sections.
 *
 * Extracted from LaunchpadDashboard.tsx to keep it under 600 lines.
 */
import React, { memo, useLayoutEffect, useRef, useState } from "react";

import { Add01Icon, HugeiconsIcon } from "@src/icons";
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";
import type { Repo } from "@src/store/repo/types";

import MacFolderIcon from "./MacFolderIcon";

const LAUNCHPAD_TILE_CLASS =
  "group/launchpadtile flex w-20 shrink-0 flex-col items-center gap-1.5 border-none bg-transparent p-0 text-center outline-none";

const LAUNCHPAD_TILE_ICON_CLASS =
  "relative flex h-12 w-16 items-center justify-center rounded-lg transition-colors duration-150 group-hover/launchpadtile:bg-fill-2";

const LAUNCHPAD_TILE_ICON_SELECTED_CLASS =
  "relative flex h-12 w-16 items-center justify-center rounded-lg bg-fill-2 transition-colors duration-150";

const LAUNCHPAD_TILE_LABEL_CLASS =
  "line-clamp-2 w-20 text-center text-[12px] font-normal leading-tight text-text-2 transition-colors group-hover/launchpadtile:text-text-1";

const LAUNCHPAD_TILE_LABEL_SELECTED_CLASS =
  "line-clamp-2 w-20 text-center text-[12px] font-normal leading-tight text-text-1";

interface LaunchpadCollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const LaunchpadCollapsibleSection: React.FC<LaunchpadCollapsibleSectionProps> =
  memo(({ title, children, defaultOpen = true, onOpenChange }) => (
    <CollapsibleSection
      title={title}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      compact
      chevronStrokeWidth={1.75}
    >
      {children}
    </CollapsibleSection>
  ));
LaunchpadCollapsibleSection.displayName = "LaunchpadCollapsibleSection";

export const LaunchpadTileWrap: React.FC<{
  children: React.ReactNode;
  actionAfterIndex?: number;
  action?: React.ReactNode;
}> = ({ children, actionAfterIndex = -1, action }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);
  const items = React.Children.toArray(children);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateColumnCount = (): void => {
      const tileWidth = 80;
      const gap = 8;
      setColumnCount(
        Math.max(
          1,
          Math.floor((container.clientWidth + gap) / (tileWidth + gap))
        )
      );
    };

    updateColumnCount();
    const observer = new ResizeObserver(updateColumnCount);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rowEndIndex =
    actionAfterIndex >= 0
      ? Math.min(
          items.length - 1,
          (Math.floor(actionAfterIndex / columnCount) + 1) * columnCount - 1
        )
      : -1;

  return (
    <div ref={containerRef} className="flex flex-wrap gap-2 pb-2">
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {item}
          {index === rowEndIndex && action ? (
            <div className="min-w-0 basis-full">{action}</div>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
};

interface LaunchpadTileProps {
  icon: React.ReactNode;
  label: string;
  title?: string;
  status?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  dataTestId?: string;
}

export const LaunchpadTile: React.FC<LaunchpadTileProps> = memo(
  ({ icon, label, title, status, selected = false, onClick, dataTestId }) => {
    const content = (
      <>
        <div
          className={
            selected
              ? LAUNCHPAD_TILE_ICON_SELECTED_CLASS
              : LAUNCHPAD_TILE_ICON_CLASS
          }
        >
          {icon}
          {status ? (
            <span className="absolute top-1.5 right-1.5">{status}</span>
          ) : null}
        </div>
        <span
          className={
            selected
              ? LAUNCHPAD_TILE_LABEL_SELECTED_CLASS
              : LAUNCHPAD_TILE_LABEL_CLASS
          }
        >
          {label}
        </span>
      </>
    );

    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          className={LAUNCHPAD_TILE_CLASS}
          title={title ?? label}
          aria-pressed={selected}
          data-testid={dataTestId}
        >
          {content}
        </button>
      );
    }

    return (
      <div className={LAUNCHPAD_TILE_CLASS} title={title ?? label}>
        {content}
      </div>
    );
  }
);
LaunchpadTile.displayName = "LaunchpadTile";

interface LaunchpadAddTileProps {
  onCreate: () => void;
  label: string;
}

export const LaunchpadAddTile: React.FC<LaunchpadAddTileProps> = memo(
  ({ onCreate, label }) => (
    <button
      type="button"
      onClick={onCreate}
      className={LAUNCHPAD_TILE_CLASS}
      title={label}
      aria-label={label}
    >
      <div className={LAUNCHPAD_TILE_ICON_CLASS}>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-1">
          <HugeiconsIcon
            icon={Add01Icon}
            data-icon="plus"
            size={18}
            strokeWidth={1.75}
            className="text-text-3"
          />
        </span>
      </div>
      <span className={LAUNCHPAD_TILE_LABEL_CLASS}>{label}</span>
    </button>
  )
);
LaunchpadAddTile.displayName = "LaunchpadAddTile";

interface LaunchpadWorkspaceCardProps {
  repo: Repo;
  selected: boolean;
  onSelect: (repo: Repo) => void;
}

export const LaunchpadWorkspaceCard: React.FC<LaunchpadWorkspaceCardProps> =
  memo(({ repo, selected, onSelect }) => {
    const label = repo.name || repo.path?.split("/").pop() || "Repo";
    const initial = label.charAt(0).toUpperCase();
    const handleClick = () => onSelect(repo);

    return (
      <button
        type="button"
        onClick={handleClick}
        className={LAUNCHPAD_TILE_CLASS}
        title={repo.path ?? label}
        aria-pressed={selected}
      >
        <div
          className={
            selected
              ? LAUNCHPAD_TILE_ICON_SELECTED_CLASS
              : LAUNCHPAD_TILE_ICON_CLASS
          }
        >
          <MacFolderIcon
            color="var(--color-primary-6)"
            label={initial}
            size={36}
            className="shrink-0"
          />
        </div>
        <span
          className={
            selected
              ? LAUNCHPAD_TILE_LABEL_SELECTED_CLASS
              : LAUNCHPAD_TILE_LABEL_CLASS
          }
        >
          {label}
        </span>
      </button>
    );
  });
LaunchpadWorkspaceCard.displayName = "LaunchpadWorkspaceCard";
