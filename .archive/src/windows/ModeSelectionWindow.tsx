/**
 * ModeSelectionWindow Page
 *
 * Standalone window page for selecting workspace mode.
 * Opened as a separate OS window via Command+N.
 *
 * Drag Behavior:
 * - Draggable regions placed strategically around edges (top, left, right, bottom)
 * - No drag cursor shown (uses default cursor for cleaner UX)
 * - Content areas remain fully interactive without drag interference
 * - Traffic light buttons (macOS) have explicit no-drag to ensure clickability
 */
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Code, Folder, FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { useRepoDropdownActions } from "@src/hooks/git/useRepoDropdownActions";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { createLogger } from "@src/hooks/logger";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { REPO_KIND } from "@src/store/repo";
import {
  closeWindow,
  maxWindow,
  minWindow,
} from "@src/util/platform/ipcRenderer";
import { isMacOS, isTauriDesktop } from "@src/util/platform/tauri";

import "./ModeSelectionWindow.scss";

const log = createLogger("ModeSelectionWindow");

const ModeSelectionWindow: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Selected repo index for highlighting
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Use existing repo dropdown actions
  const { handleEmptyRepo, handleLocalRepo, handleOpenCloneModal } =
    useRepoDropdownActions();

  // Get list of repositories lazily; this window should not eagerly scan repos.
  const {
    repos,
    repoLoading,
    selectRepo: setSelectedRepoId,
  } = useRepoSelection({
    autoLoad: false,
  });

  // Initialize window settings
  useEffect(() => {
    const initWindow = async () => {
      try {
        const window = getCurrentWindow();
        // Set transparent background for rounded corners
        await window.setBackgroundColor("rgba(0, 0, 0, 0)");
      } catch (error) {
        log.error("Failed to initialize window settings:", error);
      }
    };

    initWindow();
  }, []);

  // Handle window controls
  const closeWindowClickFunc = () => {
    closeWindow();
  };
  const minimizeWindowClickFunc = () => {
    minWindow();
  };
  const maximizeWindowClickFunc = () => {
    maxWindow();
  };

  // Check if running on macOS
  const isMac = isMacOS();

  // Prevent scrolling
  useEffect(() => {
    const container = containerRef.current;

    const preventScroll = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      return false;
    };

    const preventTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
      return false;
    };

    if (container) {
      container.addEventListener("wheel", preventScroll, { passive: false });
      container.addEventListener("touchmove", preventTouchMove, {
        passive: false,
      });
    }

    return () => {
      if (container) {
        container.removeEventListener("wheel", preventScroll);
        container.removeEventListener("touchmove", preventTouchMove);
      }
    };
  }, []);

  // Handle repo click - select repo and close window
  const handleRepoClick = async (repoId: string, index: number) => {
    try {
      setSelectedIndex(index);
    } catch (error) {
      log.error("Error handling repo click:", error);
    }
  };

  // Handle repo double click - open repo and close window
  const handleRepoDoubleClick = async (repoId: string) => {
    try {
      // Set the selected repo in global state
      setSelectedRepoId(repoId);

      // Emit event to main window to navigate
      await emit("repo-selected", { repoId });

      // Close mode selection window
      closeWindow();
    } catch (error) {
      log.error("Error handling repo double click:", error);
    }
  };

  return (
    <>
      <div
        className="mode-selection-window-backdrop-drag-region"
        data-tauri-drag-region
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        aria-hidden
      />
      <div
        className="mode-selection-window-page-container"
        ref={containerRef}
        style={
          {
            width: "900px",
            height: "520px",
            overflow: "hidden",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
      >
        {/* Invisible draggable regions (strategic placement for drag functionality) */}
        {/* Top edge drag region */}
        <div
          data-tauri-drag-region
          className="mode-selection-drag-region"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "30px",
            zIndex: 1,
            pointerEvents: "auto",
          }}
        />

        {/* Left side drag region */}
        <div
          data-tauri-drag-region
          className="mode-selection-drag-region"
          style={{
            position: "absolute",
            top: "30px",
            left: 0,
            width: "20px",
            bottom: 0,
            zIndex: 1,
            pointerEvents: "auto",
          }}
        />

        {/* Right side drag region */}
        <div
          data-tauri-drag-region
          className="mode-selection-drag-region"
          style={{
            position: "absolute",
            top: "30px",
            right: 0,
            width: "20px",
            bottom: 0,
            zIndex: 1,
            pointerEvents: "auto",
          }}
        />

        {/* Bottom edge drag region */}
        <div
          data-tauri-drag-region
          className="mode-selection-drag-region"
          style={{
            position: "absolute",
            bottom: 0,
            left: "20px",
            right: "20px",
            height: "20px",
            zIndex: 1,
            pointerEvents: "auto",
          }}
        />

        {/* Fixed Overlay Traffic Lights - macOS only */}
        {isTauriDesktop() && isMac && (
          <div
            className="fixed left-[20px] top-[19px] z-[9999] flex items-center gap-2"
            style={{ pointerEvents: "auto" }}
          >
            <div
              className="h-[14px] w-[14px] cursor-pointer rounded-full bg-[#FF5F57] transition-colors hover:bg-[#E54840]"
              onClick={closeWindowClickFunc}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            />
            <div
              className="h-[14px] w-[14px] cursor-pointer rounded-full bg-[#FEBC2E] transition-colors hover:bg-[#E0A020]"
              onClick={minimizeWindowClickFunc}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            />
            <div
              className="h-[14px] w-[14px] cursor-pointer rounded-full bg-[#28C840] transition-colors hover:bg-[#20A934]"
              onClick={maximizeWindowClickFunc}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            />
          </div>
        )}

        {/* Two-column layout */}
        <div className="mode-selection-window-layout">
          {/* Left Column - Logo and Actions */}
          <div className="mode-selection-left-column">
            {/* Logo Section */}
            <div className="mode-selection-logo-section">
              {/* App Icon */}
              <div className="mode-selection-app-icon">
                <span className="app-icon-text">S</span>
              </div>
              <h1 className="mode-selection-title">Orgii</h1>
              <p className="mode-selection-version">Version 1.0.0</p>
            </div>

            {/* Action Buttons */}
            <div className="mode-selection-actions-section">
              <div
                className="mode-selection-action-item"
                onClick={handleEmptyRepo}
                style={
                  {
                    WebkitAppRegion: "no-drag",
                    cursor: "pointer",
                  } as React.CSSProperties
                }
              >
                <div className="mode-selection-action-inner">
                  <FolderPlus
                    size={20}
                    strokeWidth={1.5}
                    className="action-icon"
                  />
                  <span className="action-label">Create New Repo...</span>
                </div>
              </div>

              <div
                className="mode-selection-action-item"
                onClick={handleOpenCloneModal}
                style={
                  {
                    WebkitAppRegion: "no-drag",
                    cursor: "pointer",
                  } as React.CSSProperties
                }
              >
                <div className="mode-selection-action-inner">
                  <GitBranch
                    size={20}
                    strokeWidth={1.5}
                    className="action-icon"
                  />
                  <span className="action-label">Clone Git Repository...</span>
                </div>
              </div>

              <div
                className="mode-selection-action-item"
                onClick={handleLocalRepo}
                style={
                  {
                    WebkitAppRegion: "no-drag",
                    cursor: "pointer",
                  } as React.CSSProperties
                }
              >
                <div className="mode-selection-action-inner">
                  <FolderOpen
                    size={20}
                    strokeWidth={1.5}
                    className="action-icon"
                  />
                  <span className="action-label">Open Existing Project...</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Repo List */}
          <div className="mode-selection-right-column">
            {/* Repo List */}
            <div className="mode-selection-repo-list">
              {repoLoading ? (
                <div className="mode-selection-repo-empty">
                  <Placeholder variant="loading" title="Loading projects..." />
                </div>
              ) : repos.length === 0 ? (
                <div className="mode-selection-repo-empty">
                  <p className="mode-selection-repo-empty-text">
                    No repositories yet
                  </p>
                  <p className="mode-selection-repo-empty-hint">
                    Create or clone a project to get started
                  </p>
                </div>
              ) : (
                repos.slice(0, 10).map((repo, index) => (
                  <div
                    key={repo.id}
                    className={`mode-selection-repo-item ${index === selectedIndex ? "selected" : ""}`}
                    onClick={() => handleRepoClick(repo.id, index)}
                    onDoubleClick={() => handleRepoDoubleClick(repo.id)}
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                  >
                    <div
                      className={`mode-selection-repo-icon-wrapper ${repo.kind === REPO_KIND.FOLDER ? "mode-selection-repo-icon-wrapper--folder" : ""}`}
                    >
                      {repo.kind === REPO_KIND.FOLDER ? (
                        <Folder
                          className="mode-selection-repo-icon"
                          size={20}
                        />
                      ) : (
                        <Code className="mode-selection-repo-icon" size={20} />
                      )}
                    </div>
                    <div className="mode-selection-repo-info">
                      <div className="mode-selection-repo-name">
                        {repo.name}
                      </div>
                      <div className="mode-selection-repo-path">
                        {repo.fs_uri
                          ?.replace("file://", "")
                          ?.replace(/^\/Users\/[^/]+/, "~") || "No path"}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default ModeSelectionWindow;
