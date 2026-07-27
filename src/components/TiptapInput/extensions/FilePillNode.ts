import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import FilePillNodeView from "./FilePillNodeView";
import type { PillIconType } from "./types";

export type { PillIconType } from "./types";

export interface FilePillOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    filePill: {
      insertFilePill: (options: {
        filePath: string;
        fileName: string;
        isFolder?: boolean;
        iconType?: PillIconType;
        lineStart?: number;
        lineEnd?: number;
      }) => ReturnType;
      removeFilePill: (filePath: string) => ReturnType;
    };
  }
}

export const FilePillNode = Node.create<FilePillOptions>({
  name: "filePill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      filePath: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-file-path"),
        renderHTML: (attributes) => ({
          "data-file-path": attributes.filePath,
        }),
      },
      fileName: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-file-name"),
        renderHTML: (attributes) => ({
          "data-file-name": attributes.fileName,
        }),
      },
      isFolder: {
        default: false,
        parseHTML: (element) =>
          element.getAttribute("data-is-folder") === "true",
        renderHTML: (attributes) => ({
          "data-is-folder": String(attributes.isFolder),
        }),
      },
      iconType: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-icon-type"),
        renderHTML: (attributes) => ({
          "data-icon-type": attributes.iconType,
        }),
      },
      lineStart: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("data-line-start");
          return value ? parseInt(value, 10) : null;
        },
        renderHTML: (attributes) => ({
          "data-line-start": attributes.lineStart,
        }),
      },
      lineEnd: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("data-line-end");
          return value ? parseInt(value, 10) : null;
        },
        renderHTML: (attributes) => ({
          "data-line-end": attributes.lineEnd,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="file-pill"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { "data-type": "file-pill", class: "file-pill" },
        this.options.HTMLAttributes,
        HTMLAttributes
      ),
      HTMLAttributes.fileName || "",
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FilePillNodeView);
  },

  addCommands() {
    return {
      insertFilePill:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              filePath: options.filePath,
              fileName: options.fileName,
              isFolder: options.isFolder || false,
              iconType: options.iconType || null,
              lineStart: options.lineStart ?? null,
              lineEnd: options.lineEnd ?? null,
            },
          }),
      removeFilePill:
        (filePath) =>
        ({ editor, tr }) => {
          let deleted = false;
          editor.state.doc.descendants((node, pos) => {
            if (
              node.type.name === this.name &&
              node.attrs.filePath === filePath
            ) {
              tr.delete(pos, pos + node.nodeSize);
              deleted = true;
              return false;
            }
          });
          return deleted;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { $from } = this.editor.state.selection;
        const nodeBefore = $from.nodeBefore;
        if (nodeBefore?.type.name !== this.name) return false;
        return this.editor.commands.deleteRange({
          from: $from.pos - nodeBefore.nodeSize,
          to: $from.pos,
        });
      },
      Delete: () => {
        const { $from } = this.editor.state.selection;
        const nodeAfter = $from.nodeAfter;
        if (nodeAfter?.type.name !== this.name) return false;
        return this.editor.commands.deleteRange({
          from: $from.pos,
          to: $from.pos + nodeAfter.nodeSize,
        });
      },
    };
  },
});

export default FilePillNode;
