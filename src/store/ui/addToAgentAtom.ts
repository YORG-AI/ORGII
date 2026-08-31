/**
 * addToAgentAtom
 *
 * Holds a pending "add to agent" request from the WorkStation code editor
 * text-selection dropdown. Written by the editor handler; consumed and cleared
 * by useInputAreaEffects when the InputArea mounts or when the value changes.
 *
 * Using an atom instead of a CustomEvent avoids the race condition where the
 * ChatPanel InputArea is not mounted (chat panel closed / floating input
 * collapsed), which caused the event to fire with no listener.
 */
import { atom } from "jotai";

export type AddToAgentRequest =
  | {
      type: "file";
      filePath: string;
      fileName: string;
    }
  | {
      type: "lines";
      filePath: string;
      fileName: string;
      lineStart: number;
      lineEnd: number;
    }
  | {
      type: "terminal";
      /**
       * Raw selected text from a terminal or read-only DOM surface. The
       * historical discriminator is retained because it maps to the existing
       * terminal-style raw-text pill protocol.
       */
      text: string;
      /** Display label for the pill (e.g. a file/view name or "Terminal (1-12)") */
      displayName?: string;
      /** 1-based buffer row where the selection starts */
      lineStart?: number;
      /** 1-based buffer row where the selection ends */
      lineEnd?: number;
    }
  | {
      type: "dom-element";
      /**
       * Structured text blob describing the element. Rendered as a pill and
       * resolved back to full content via the pill-text store.
       */
      text: string;
      /** Short display label for the pill (e.g. "div.hp_trivia_outer"). */
      displayName: string;
    }
  | {
      type: "dom-component";
      /** Paste-pill display name, e.g. "ComposerShell.json" */
      fileName: string;
      /** JSON text matching the DomComponentPreview schema */
      jsonText: string;
    }
  | {
      type: "issue";
      issueNumber: number;
      issueTitle: string;
      issueUrl: string;
      issueState: string;
      labels?: string[];
      assignees?: string[];
      comments?: number;
    }
  | {
      type: "pr";
      prNumber: number;
      prTitle: string;
      prUrl: string;
      prStatus: string;
      sourceBranch?: string;
      targetBranch?: string;
    };

export const addToAgentAtom = atom<AddToAgentRequest | null>(null);
addToAgentAtom.debugLabel = "addToAgentAtom";
