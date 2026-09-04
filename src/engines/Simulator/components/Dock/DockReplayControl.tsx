/**
 * DockReplayControl Component
 *
 * macOS-style dock control bar for simulator application management.
 * Provides navigation between different simulator tools and apps.
 * The dock appearance is consistent in both Live and Replay modes.
 *
 * Note: Replay bar is now handled by SimulatorContentArea component.
 */
import {
  type FC,
  Fragment,
  type MouseEvent,
  type ReactNode,
  memo,
  useCallback,
} from "react";

import AnyIcon from "@src/components/AnyIcon";

import { AppType } from "../../types/appTypes";
import { DOCK_APPS, DOCK_APP_SEGMENTS, getAppById } from "./config";
import {
  DOCK_ICON_PROPS,
  DockIconColumn,
  DockSegmentDivider,
  StationDockGlassPill,
  StationDockRow,
  dockIconHitAreaClassName,
} from "./dockLayout";

interface DockReplayControlProps {
  /** Active dock highlight — null when the current event maps to no dock app */
  activeApp: AppType | null;
  /** Current app the agent is working on (shows blue dot indicator) */
  currentWorkingApp?: AppType;
  /** Whether to show the dock icons */
  showDock?: boolean;
  /** Callback when a dock app is clicked */
  onAppClick?: (appId: string, event?: MouseEvent) => void;
  /** Callback when a dock app is right-clicked */
  onAppContextMenu?: (appId: string, event: MouseEvent) => void;
  /** Element rendered immediately to the right of the dock glass */
  trailing?: ReactNode;
}

export const DockReplayControl: FC<DockReplayControlProps> = memo(
  ({
    activeApp,
    currentWorkingApp,
    showDock = true,
    onAppClick,
    onAppContextMenu,
    trailing,
  }) => {
    const isInDock =
      activeApp != null && DOCK_APPS.some((app) => app.id === activeApp);
    const showActive = activeApp != null && !isInDock;

    const activeAppInfo = showActive ? getAppById(activeApp) : null;

    const handleAppClick = useCallback(
      (appId: string, event: MouseEvent) => {
        if (event.shiftKey) {
          onAppContextMenu?.(appId, event);
          return;
        }

        onAppClick?.(appId, event);
      },
      [onAppClick, onAppContextMenu]
    );

    const handleContextMenu = useCallback(
      (appId: string, event: MouseEvent) => {
        event.preventDefault();
        onAppContextMenu?.(appId, event);
      },
      [onAppContextMenu]
    );

    if (!showDock) {
      return null;
    }

    return (
      <StationDockRow layout="withTrailingSlot" trailing={trailing}>
        <StationDockGlassPill>
          {DOCK_APP_SEGMENTS.map((segment, segmentIndex) => (
            <Fragment key={segmentIndex}>
              {segmentIndex > 0 && <DockSegmentDivider />}
              {segment.map((app) => {
                const isActive = activeApp === app.id;
                const isWorking = currentWorkingApp === app.id;

                return (
                  <DockIconColumn
                    key={app.id}
                    trailer={isWorking ? "agent-working" : "spacer"}
                  >
                    <div
                      className={dockIconHitAreaClassName({ active: isActive })}
                      onClick={(e) => handleAppClick(app.id, e)}
                      onContextMenu={(e) => handleContextMenu(app.id, e)}
                      title={app.name}
                    >
                      <AnyIcon icon={app.icon} {...DOCK_ICON_PROPS} />
                    </div>
                  </DockIconColumn>
                );
              })}
            </Fragment>
          ))}

          {showActive && activeAppInfo && (
            <>
              <DockSegmentDivider />
              <DockIconColumn trailer="overflow-marker">
                <div
                  className={dockIconHitAreaClassName({ forcePrimary: true })}
                  onClick={(e) => handleAppClick(activeAppInfo.id, e)}
                  onContextMenu={(e) => handleContextMenu(activeAppInfo.id, e)}
                  title={activeAppInfo.name}
                >
                  <AnyIcon icon={activeAppInfo.icon} {...DOCK_ICON_PROPS} />
                </div>
              </DockIconColumn>
            </>
          )}
        </StationDockGlassPill>
      </StationDockRow>
    );
  }
);

DockReplayControl.displayName = "DockReplayControl";
