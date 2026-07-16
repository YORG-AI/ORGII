/**
 * SoftwareIcon Configuration
 *
 * SVG icon imports and mappings for IDEs, editors, and CLI tools.
 * IDE IDs match the `id` field from `server_detect_ides` in external_ide.rs.
 */
import React from "react";

import ClaudeIcon from "@src/assets/modelIcons/claude.svg";
import CodexIcon from "@src/assets/modelIcons/codex.svg";
import CursorIcon from "@src/assets/modelIcons/cursor.svg";
import GeminiIcon from "@src/assets/modelIcons/gemini";
import AiderIcon from "@src/assets/softwareIcons/aider.svg";
import AndroidStudioIcon from "@src/assets/softwareIcons/android-studio.svg";
import AtomIcon from "@src/assets/softwareIcons/atom.svg";
import EclipseIcon from "@src/assets/softwareIcons/eclipse.svg";
import EmacsIcon from "@src/assets/softwareIcons/emacs.svg";
import FleetIcon from "@src/assets/softwareIcons/fleet.svg";
import HelixIcon from "@src/assets/softwareIcons/helix.svg";
import JetBrainsIcon from "@src/assets/softwareIcons/jetbrains.svg";
import KiroIcon from "@src/assets/softwareIcons/kiro.svg";
import LapceIcon from "@src/assets/softwareIcons/lapce.svg";
import NeovimIcon from "@src/assets/softwareIcons/neovim.svg";
import NetBeansIcon from "@src/assets/softwareIcons/netbeans.svg";
import NovaIcon from "@src/assets/softwareIcons/nova.svg";
import SublimeIcon from "@src/assets/softwareIcons/sublime.svg";
import TextMateIcon from "@src/assets/softwareIcons/textmate.svg";
import TraeIcon from "@src/assets/softwareIcons/trae.svg";
import VimIcon from "@src/assets/softwareIcons/vim.svg";
import VSCodeInsidersIcon from "@src/assets/softwareIcons/vscode-insiders.svg";
import VSCodeIcon from "@src/assets/softwareIcons/vscode.svg";
import WindsurfIcon from "@src/assets/softwareIcons/windsurf.svg";
import XcodeIcon from "@src/assets/softwareIcons/xcode.svg";
import ZedIcon from "@src/assets/softwareIcons/zed.svg";

export type SoftwareType =
  | "vscode"
  | "vscode-insiders"
  | "cursor"
  | "trae"
  | "windsurf"
  | "zed"
  | "fleet"
  | "sublime"
  | "intellij"
  | "webstorm"
  | "pycharm"
  | "goland"
  | "phpstorm"
  | "rubymine"
  | "clion"
  | "rider"
  | "rustrover"
  | "vim"
  | "nvim"
  | "emacs"
  | "helix"
  | "kakoune"
  | "lapce"
  | "xcode"
  | "android-studio"
  | "nova"
  | "textmate"
  | "eclipse"
  | "netbeans"
  | "atom"
  | "claude"
  | "codex"
  | "aider"
  | "gemini-cli"
  | "kiro";

type SvgComponent = React.FC<React.SVGProps<SVGSVGElement>>;

export const SOFTWARE_ICON_MAP: Partial<Record<SoftwareType, SvgComponent>> = {
  vscode: VSCodeIcon,
  "vscode-insiders": VSCodeInsidersIcon,
  cursor: CursorIcon,
  trae: TraeIcon,
  windsurf: WindsurfIcon,
  zed: ZedIcon,
  fleet: FleetIcon,
  sublime: SublimeIcon,
  intellij: JetBrainsIcon,
  webstorm: JetBrainsIcon,
  pycharm: JetBrainsIcon,
  goland: JetBrainsIcon,
  phpstorm: JetBrainsIcon,
  rubymine: JetBrainsIcon,
  clion: JetBrainsIcon,
  rider: JetBrainsIcon,
  rustrover: JetBrainsIcon,
  vim: VimIcon,
  nvim: NeovimIcon,
  emacs: EmacsIcon,
  helix: HelixIcon,
  kakoune: VimIcon,
  lapce: LapceIcon,
  xcode: XcodeIcon,
  "android-studio": AndroidStudioIcon,
  nova: NovaIcon,
  textmate: TextMateIcon,
  eclipse: EclipseIcon,
  netbeans: NetBeansIcon,
  atom: AtomIcon,
  aider: AiderIcon,
  kiro: KiroIcon,
  claude: ClaudeIcon,
  codex: CodexIcon,
  "gemini-cli": GeminiIcon,
};

/**
 * Maps display names and activity source IDs to SoftwareType.
 *
 * Handles three naming conventions:
 * - Display names from DependencyStatus.name (e.g. "Visual Studio Code")
 * - Activity source IDs from coding tracker (e.g. "claude_code", "kiro_cli")
 * - IDE IDs from server_detect_ides pass through without mapping
 */
export const SOFTWARE_NAME_TO_ID: Record<string, SoftwareType> = {
  "Visual Studio Code": "vscode",
  "VS Code Insiders": "vscode-insiders",
  Cursor: "cursor",
  Trae: "trae",
  Windsurf: "windsurf",
  Zed: "zed",
  Fleet: "fleet",
  "Sublime Text": "sublime",
  "IntelliJ IDEA": "intellij",
  WebStorm: "webstorm",
  PyCharm: "pycharm",
  GoLand: "goland",
  PhpStorm: "phpstorm",
  RubyMine: "rubymine",
  CLion: "clion",
  Rider: "rider",
  RustRover: "rustrover",
  Vim: "vim",
  Neovim: "nvim",
  Emacs: "emacs",
  Helix: "helix",
  Kakoune: "kakoune",
  Lapce: "lapce",
  Xcode: "xcode",
  "Android Studio": "android-studio",
  Nova: "nova",
  TextMate: "textmate",
  Eclipse: "eclipse",
  NetBeans: "netbeans",
  Atom: "atom",
  "Claude Code": "claude",
  Codex: "codex",
  Aider: "aider",
  "Gemini CLI": "gemini-cli",
  Kiro: "kiro",
  // Activity source IDs from coding tracker (underscore convention)
  claude_code: "claude",
  gemini_cli: "gemini-cli",
  kiro_cli: "kiro",
  jetbrains: "intellij",
};
