import type { Editor } from "@tiptap/react";
import {
  Bold,
  ChevronDown,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline as UnderlineIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface FloatingToolbarProps {
  editor: Editor;
  position: { top: number; left: number };
  onImagePickerOpen?: () => void;
  className?: string;
}

export const FloatingToolbar: React.FC<FloatingToolbarProps> = ({
  editor,
  position,
  onImagePickerOpen,
  className = "",
}) => {
  const { t } = useTranslation("sessions");
  const [showHeadingDropdown, setShowHeadingDropdown] = useState(false);
  const [showListDropdown, setShowListDropdown] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolbarRef.current && !toolbarRef.current.contains(target)) {
        setShowHeadingDropdown(false);
        setShowListDropdown(false);
        setShowLinkInput(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const closeOtherDropdowns = (keep: "heading" | "list" | "link") => {
    if (keep !== "heading") setShowHeadingDropdown(false);
    if (keep !== "list") setShowListDropdown(false);
    if (keep !== "link") setShowLinkInput(false);
  };

  const handleLinkSubmit = () => {
    const href = linkUrl.trim();
    if (href) editor.chain().focus().setLink({ href }).run();
    else editor.chain().focus().unsetLink().run();
    setShowLinkInput(false);
    setLinkUrl("");
  };

  const handleHeadingSelect = (level: 1 | 2 | 3 | null) => {
    if (level === null) editor.chain().focus().setParagraph().run();
    else editor.chain().focus().toggleHeading({ level }).run();
    setShowHeadingDropdown(false);
  };

  const handleListSelect = (listType: "bullet" | "ordered" | "task") => {
    const chain = editor.chain().focus();
    if (listType === "bullet") chain.toggleBulletList().run();
    else if (listType === "ordered") chain.toggleOrderedList().run();
    else chain.toggleTaskList().run();
    setShowListDropdown(false);
  };

  const currentHeading = editor.isActive("heading", { level: 1 })
    ? "H1"
    : editor.isActive("heading", { level: 2 })
      ? "H2"
      : editor.isActive("heading", { level: 3 })
        ? "H3"
        : "Aa";

  return createPortal(
    <div
      ref={toolbarRef}
      className={`rich-text-editor-toolbar ${className}`.trim()}
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        zIndex: 99999,
      }}
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label={t("creator.toolbar.formatting", "Text formatting")}
    >
      <div className="toolbar-dropdown">
        <button
          type="button"
          className="toolbar-btn dropdown-trigger"
          onClick={() => {
            setShowHeadingDropdown((value) => !value);
            closeOtherDropdowns("heading");
          }}
          title={t("creator.toolbar.normalText")}
          aria-label={t("creator.toolbar.normalText")}
        >
          <span className="heading-label">{currentHeading}</span>
          <ChevronDown size={12} />
        </button>
        {showHeadingDropdown && (
          <div className="dropdown-menu">
            <button
              type="button"
              className={`dropdown-item ${!editor.isActive("heading") ? "active" : ""}`}
              onClick={() => handleHeadingSelect(null)}
            >
              <Type size={14} />
              <span>{t("creator.toolbar.normalText")}</span>
            </button>
            {([1, 2, 3] as const).map((level) => {
              const Icon =
                level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
              return (
                <button
                  key={level}
                  type="button"
                  className={`dropdown-item ${editor.isActive("heading", { level }) ? "active" : ""}`}
                  onClick={() => handleHeadingSelect(level)}
                >
                  <Icon size={14} />
                  <span>{t(`creator.toolbar.heading${level}`)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="toolbar-divider" />

      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("bold") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title={t("creator.toolbar.bold")}
        aria-label={t("creator.toolbar.bold")}
      >
        <Bold size={16} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("italic") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title={t("creator.toolbar.italic")}
        aria-label={t("creator.toolbar.italic")}
      >
        <Italic size={16} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("strike") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title={t("creator.toolbar.strikethrough")}
        aria-label={t("creator.toolbar.strikethrough")}
      >
        <Strikethrough size={16} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("underline") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title={t("creator.toolbar.underline")}
        aria-label={t("creator.toolbar.underline")}
      >
        <UnderlineIcon size={16} />
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("code") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title={t("creator.toolbar.inlineCode")}
        aria-label={t("creator.toolbar.inlineCode")}
      >
        <Code size={16} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("highlight") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        title={t("creator.toolbar.highlight")}
        aria-label={t("creator.toolbar.highlight")}
      >
        <Highlighter size={16} />
      </button>

      <div className="toolbar-link-wrapper">
        <button
          type="button"
          className={`toolbar-btn ${editor.isActive("link") ? "active" : ""}`}
          onClick={() => {
            if (editor.isActive("link")) {
              editor.chain().focus().unsetLink().run();
            } else {
              setShowLinkInput((value) => !value);
              closeOtherDropdowns("link");
            }
          }}
          title={t("creator.toolbar.link")}
          aria-label={t("creator.toolbar.link")}
        >
          <LinkIcon size={16} />
        </button>
        {showLinkInput && (
          <div
            className="link-input-popup"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <input
              type="url"
              placeholder={t("creator.toolbar.enterUrl")}
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleLinkSubmit();
                else if (event.key === "Escape") {
                  setShowLinkInput(false);
                  setLinkUrl("");
                }
              }}
              autoFocus
            />
            <button type="button" onClick={handleLinkSubmit}>
              {t("common:actions.apply")}
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("blockquote") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title={t("creator.toolbar.quote")}
        aria-label={t("creator.toolbar.quote")}
      >
        <Quote size={16} />
      </button>

      <div className="toolbar-dropdown">
        <button
          type="button"
          className="toolbar-btn dropdown-trigger"
          onClick={() => {
            setShowListDropdown((value) => !value);
            closeOtherDropdowns("list");
          }}
          title={t("creator.toolbar.lists")}
          aria-label={t("creator.toolbar.lists")}
        >
          <List size={16} />
          <ChevronDown size={12} />
        </button>
        {showListDropdown && (
          <div className="dropdown-menu dropdown-menu-right">
            <button
              type="button"
              className={`dropdown-item ${editor.isActive("bulletList") ? "active" : ""}`}
              onClick={() => handleListSelect("bullet")}
            >
              <List size={14} />
              <span>{t("creator.toolbar.bulletList")}</span>
            </button>
            <button
              type="button"
              className={`dropdown-item ${editor.isActive("orderedList") ? "active" : ""}`}
              onClick={() => handleListSelect("ordered")}
            >
              <ListOrdered size={14} />
              <span>{t("creator.toolbar.numberedList")}</span>
            </button>
            <button
              type="button"
              className={`dropdown-item ${editor.isActive("taskList") ? "active" : ""}`}
              onClick={() => handleListSelect("task")}
            >
              <ListTodo size={14} />
              <span>{t("creator.toolbar.taskList")}</span>
            </button>
            <div className="dropdown-divider" />
            <button
              type="button"
              className="dropdown-item"
              onClick={() => {
                editor.chain().focus().setHorizontalRule().run();
                setShowListDropdown(false);
              }}
            >
              <Minus size={14} />
              <span>{t("creator.toolbar.divider")}</span>
            </button>
          </div>
        )}
      </div>

      {onImagePickerOpen && (
        <button
          type="button"
          className="toolbar-btn"
          onClick={onImagePickerOpen}
          title={t("creator.toolbar.insertImage")}
          aria-label={t("creator.toolbar.insertImage")}
        >
          <ImageIcon size={16} />
        </button>
      )}
      <button
        type="button"
        className="toolbar-btn"
        onClick={() =>
          editor.chain().focus().unsetAllMarks().clearNodes().run()
        }
        title={t("creator.toolbar.clearFormatting")}
        aria-label={t("creator.toolbar.clearFormatting")}
      >
        <RemoveFormatting size={16} />
      </button>
    </div>,
    document.body
  );
};
