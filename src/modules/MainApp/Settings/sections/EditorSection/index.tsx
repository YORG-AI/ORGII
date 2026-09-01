/**
 * Editor & Workspace Settings Section
 *
 * One tab: `editor` (terminal, language servers, workspace default path).
 */
import React from "react";

import TerminalSection from "./components/TerminalSettingsSection";
import WorkspaceDefaultPathSection from "./components/WorkspaceDefaultPathSection";

const EditorSection: React.FC = () => (
  <>
    <WorkspaceDefaultPathSection />
    <TerminalSection />
  </>
);

export default EditorSection;
