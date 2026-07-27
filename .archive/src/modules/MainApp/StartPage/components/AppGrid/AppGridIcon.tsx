/**
 * AppGridIcon
 *
 * Single app icon cell in the honeycomb AppGrid. Renders the translucent
 * circular background, the Lucide icon, the label, and handles all pointer
 * and interaction events for both normal and edit (drag) modes.
 */
import { motion } from "framer-motion";
import React from "react";
import { useTranslation } from "react-i18next";

import { triggerIconAnimation } from "@src/scaffold/NavigationSidebar/components/HoverAnimatedIcon";
import { classNames } from "@src/util/ui/classNames";

import type { AppItem } from "./config";

export interface AppGridIconProps {
  app: AppItem;
  globalIndex: number;
  itemWidth: number;
  iconSize: number;
  iconColor: string;
  labelColor: string;
  editMode: boolean;
  isBeingDragged: boolean;
  isDragOver: boolean;
  isDraggingRef: React.MutableRefObject<boolean>;
  onAppClick: (app: AppItem, event?: React.MouseEvent) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerMove?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onPointerCancel?: () => void;
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
}

export const AppGridIcon: React.FC<AppGridIconProps> = ({
  app,
  globalIndex,
  itemWidth,
  iconSize,
  iconColor,
  editMode,
  isBeingDragged,
  isDragOver,
  isDraggingRef,
  labelColor,
  onAppClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onTouchStart,
  onTouchEnd,
}) => {
  const { t } = useTranslation();
  const IconComponent = app.icon;
  const appLabel = app.labelKey.includes(":") ? t(app.labelKey) : app.labelKey;

  return (
    <motion.div
      key={app.id}
      initial={{ opacity: 0, scale: 0.8, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{
        duration: 0.4,
        delay: globalIndex * 0.05,
        ease: [0.34, 1.56, 0.64, 1],
      }}
      style={{ width: `${itemWidth}px` }}
    >
      <div
        className={classNames(
          "vision-app-item flex flex-col items-center gap-2 focus:outline-none",
          editMode && "shaking",
          isBeingDragged && "dragging",
          isDragOver && "drag-over"
        )}
        role="button"
        tabIndex={0}
        data-app-id={app.id}
        onPointerDown={editMode ? onPointerDown : undefined}
        onPointerMove={editMode ? onPointerMove : undefined}
        onPointerUp={editMode ? onPointerUp : undefined}
        onPointerCancel={editMode ? onPointerCancel : undefined}
        onClick={(event) => {
          if (!isDraggingRef.current && !editMode) {
            onAppClick(app, event);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !editMode) onAppClick(app);
        }}
        onMouseEnter={(event) => {
          if (!editMode) {
            triggerIconAnimation(event.currentTarget);
          }
        }}
        {...(!editMode && {
          onTouchStart,
          onTouchEnd,
          onMouseDown: onTouchStart,
          onMouseUp: onTouchEnd,
          onMouseLeave: onTouchEnd,
        })}
        style={{
          width: "100%",
          cursor: editMode ? (isBeingDragged ? "grabbing" : "grab") : "pointer",
          touchAction: editMode ? "none" : "auto",
        }}
      >
        <div
          className="vision-app-icon relative flex items-center justify-center"
          style={{
            width: `${iconSize}px`,
            height: `${iconSize}px`,
            borderRadius: "50%",
            background: "var(--start-app-icon-bg)",
            backdropFilter: "var(--start-app-icon-backdrop)",
            WebkitBackdropFilter: "var(--start-app-icon-backdrop)",
            boxShadow: "var(--start-app-icon-shadow)",
          }}
        >
          <span
            data-icon-wrapper={app.iconName}
            className="relative z-[1] inline-flex items-center justify-center"
          >
            <IconComponent size={28} color={iconColor} strokeWidth={1.75} />
          </span>
        </div>

        <span
          className="text-center text-[14px] font-normal"
          style={{ color: labelColor }}
        >
          {appLabel}
        </span>
      </div>
    </motion.div>
  );
};
