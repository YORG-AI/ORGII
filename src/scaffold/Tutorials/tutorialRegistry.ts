import { CODE_EDITOR_TOUR_EVENT } from "./codeEditorTourConfig";
import { GENERAL_LAYOUT_TOUR_EVENT } from "./generalLayoutTourConfig";

export const TUTORIALS_OPEN_EVENT = "orgii:open-tutorials";

export type TutorialId = "general-layout" | "code-editor";

export interface TutorialEntry {
  id: TutorialId;
  title: string;
  description: string;
  durationLabel: string;
  eventName: string;
}

export const TUTORIALS: TutorialEntry[] = [
  {
    id: "general-layout",
    title: "General layout tour",
    description:
      "Learn the Session sidebar, Chat Panel, station mode switcher, Workstation, dock, and app areas.",
    durationLabel: "1 min",
    eventName: GENERAL_LAYOUT_TOUR_EVENT,
  },
  {
    id: "code-editor",
    title: "Code Editor tour",
    description:
      "Learn tabs, repo and branch switching, Source Control, Git History, and the project dashboard.",
    durationLabel: "2 min",
    eventName: CODE_EDITOR_TOUR_EVENT,
  },
];
