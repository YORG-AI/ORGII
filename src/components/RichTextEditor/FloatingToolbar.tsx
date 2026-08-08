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
import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import type { DropdownPosition } from "@src/components/Dropdown";
import {
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DropdownItem,
  DropdownPanel,
} from "@src/components/Dropdown/exports";
import Input from "@src/components/Input";

interface FloatingToolbarProps {
  editor: Editor;
  position?: { top: number; left: number };
  placement?: "floating" | "inline";
  onImagePickerOpen?: () => void;
  className?: string;
  size?: "mini" | "small";
  dropdownPosition?: DropdownPosition;
}

const getToolbarPopupContainer = () => document.body;
const TOOLBAR_ICON_SIZE = 14;
const TOOLBAR_DROPDOWN_STYLE: React.CSSProperties = {
  zIndex: DROPDOWN_PANEL.portalSubmenuZIndex,
};

export const FloatingToolbar: React.FC<FloatingToolbarProps> = ({
  editor,
  position,
  placement = "floating",
  onImagePickerOpen,
  className = "",
  size = "small",
  dropdownPosition = "bottom-start",
}) => {
  const { t } = useTranslation("sessions");
  const [showHeadingDropdown, setShowHeadingDropdown] = useState(false);
  const [showListDropdown, setShowListDropdown] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

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

  const toolbar = (
    <div
      ref={toolbarRef}
      className={`rich-text-editor-toolbar ${
        placement === "inline" ? "rich-text-editor-toolbar-inline" : ""
      } ${size === "mini" ? "rich-text-editor-toolbar-mini" : ""} ${className}`.trim()}
      style={
        placement === "floating" && position
          ? {
              position: "fixed",
              top: position.top,
              left: position.left,
              zIndex: 99999,
            }
          : undefined
      }
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label={t("creator.toolbar.formatting", "Text formatting")}
    >
      <Dropdown
        droplist={
          <DropdownPanel
            minWidth={160}
            className="p-1"
            role="listbox"
            aria-label={t("creator.toolbar.normalText")}
          >
            <DropdownItem
              icon={<Type size={DROPDOWN_ITEM.iconSize} />}
              selected={!editor.isActive("heading")}
              onClick={() => handleHeadingSelect(null)}
            >
              {t("creator.toolbar.normalText")}
            </DropdownItem>
            {([1, 2, 3] as const).map((level) => {
              const Icon =
                level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
              return (
                <DropdownItem
                  key={level}
                  icon={<Icon size={DROPDOWN_ITEM.iconSize} />}
                  selected={editor.isActive("heading", { level })}
                  onClick={() => handleHeadingSelect(level)}
                >
                  {t(`creator.toolbar.heading${level}`)}
                </DropdownItem>
              );
            })}
          </DropdownPanel>
        }
        trigger="click"
        position={dropdownPosition}
        popupVisible={showHeadingDropdown}
        onVisibleChange={(visible) => {
          setShowHeadingDropdown(visible);
          if (visible) closeOtherDropdowns("heading");
        }}
        getPopupContainer={getToolbarPopupContainer}
        avoidViewportOverflow
        style={TOOLBAR_DROPDOWN_STYLE}
      >
        <button
          type="button"
          className="toolbar-btn dropdown-trigger"
          title={t("creator.toolbar.normalText")}
          aria-label={t("creator.toolbar.normalText")}
          aria-haspopup="listbox"
          aria-expanded={showHeadingDropdown}
        >
          <span className="heading-label">{currentHeading}</span>
          <ChevronDown size={TOOLBAR_ICON_SIZE} />
        </button>
      </Dropdown>

      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("bold") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title={t("creator.toolbar.bold")}
        aria-label={t("creator.toolbar.bold")}
      >
        <Bold size={TOOLBAR_ICON_SIZE} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("italic") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title={t("creator.toolbar.italic")}
        aria-label={t("creator.toolbar.italic")}
      >
        <Italic size={TOOLBAR_ICON_SIZE} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("strike") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title={t("creator.toolbar.strikethrough")}
        aria-label={t("creator.toolbar.strikethrough")}
      >
        <Strikethrough size={TOOLBAR_ICON_SIZE} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("underline") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title={t("creator.toolbar.underline")}
        aria-label={t("creator.toolbar.underline")}
      >
        <UnderlineIcon size={TOOLBAR_ICON_SIZE} />
      </button>

      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("code") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title={t("creator.toolbar.inlineCode")}
        aria-label={t("creator.toolbar.inlineCode")}
      >
        <Code size={TOOLBAR_ICON_SIZE} />
      </button>
      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("highlight") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        title={t("creator.toolbar.highlight")}
        aria-label={t("creator.toolbar.highlight")}
      >
        <Highlighter size={TOOLBAR_ICON_SIZE} />
      </button>

      <Dropdown
        droplist={
          <DropdownPanel
            minWidth={280}
            className="p-1.5"
            role="dialog"
            aria-label={t("creator.toolbar.link")}
          >
            <div
              className="flex items-center gap-1.5"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <Input
                type="url"
                size="small"
                className="w-48"
                placeholder={t("creator.toolbar.enterUrl")}
                value={linkUrl}
                onChange={setLinkUrl}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleLinkSubmit();
                  else if (event.key === "Escape") {
                    setShowLinkInput(false);
                    setLinkUrl("");
                  }
                }}
                autoFocus
              />
              <Button
                htmlType="button"
                variant="primary"
                size="small"
                onClick={handleLinkSubmit}
              >
                {t("common:actions.apply")}
              </Button>
            </div>
          </DropdownPanel>
        }
        trigger="click"
        position={dropdownPosition}
        popupVisible={showLinkInput}
        onVisibleChange={(visible) => {
          setShowLinkInput(visible);
          if (visible) closeOtherDropdowns("link");
        }}
        getPopupContainer={getToolbarPopupContainer}
        avoidViewportOverflow
        style={TOOLBAR_DROPDOWN_STYLE}
      >
        <button
          type="button"
          className={`toolbar-btn ${editor.isActive("link") ? "active" : ""}`}
          onClick={(event) => {
            if (editor.isActive("link")) {
              event.stopPropagation();
              editor.chain().focus().unsetLink().run();
              setShowLinkInput(false);
            }
          }}
          title={t("creator.toolbar.link")}
          aria-label={t("creator.toolbar.link")}
          aria-haspopup="dialog"
          aria-expanded={showLinkInput}
        >
          <LinkIcon size={TOOLBAR_ICON_SIZE} />
        </button>
      </Dropdown>

      <button
        type="button"
        className={`toolbar-btn ${editor.isActive("blockquote") ? "active" : ""}`}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title={t("creator.toolbar.quote")}
        aria-label={t("creator.toolbar.quote")}
      >
        <Quote size={TOOLBAR_ICON_SIZE} />
      </button>

      <Dropdown
        droplist={
          <DropdownPanel
            minWidth={160}
            className="p-1"
            role="listbox"
            aria-label={t("creator.toolbar.lists")}
          >
            <DropdownItem
              icon={<List size={DROPDOWN_ITEM.iconSize} />}
              selected={editor.isActive("bulletList")}
              onClick={() => handleListSelect("bullet")}
            >
              {t("creator.toolbar.bulletList")}
            </DropdownItem>
            <DropdownItem
              icon={<ListOrdered size={DROPDOWN_ITEM.iconSize} />}
              selected={editor.isActive("orderedList")}
              onClick={() => handleListSelect("ordered")}
            >
              {t("creator.toolbar.numberedList")}
            </DropdownItem>
            <DropdownItem
              icon={<ListTodo size={DROPDOWN_ITEM.iconSize} />}
              selected={editor.isActive("taskList")}
              onClick={() => handleListSelect("task")}
            >
              {t("creator.toolbar.taskList")}
            </DropdownItem>
            <div className="my-1 h-px bg-border-2" role="separator" />
            <DropdownItem
              icon={<Minus size={DROPDOWN_ITEM.iconSize} />}
              showCheckmark={false}
              onClick={() => {
                editor.chain().focus().setHorizontalRule().run();
                setShowListDropdown(false);
              }}
            >
              {t("creator.toolbar.divider")}
            </DropdownItem>
          </DropdownPanel>
        }
        trigger="click"
        position={dropdownPosition}
        popupVisible={showListDropdown}
        onVisibleChange={(visible) => {
          setShowListDropdown(visible);
          if (visible) closeOtherDropdowns("list");
        }}
        getPopupContainer={getToolbarPopupContainer}
        avoidViewportOverflow
        style={TOOLBAR_DROPDOWN_STYLE}
      >
        <button
          type="button"
          className="toolbar-btn dropdown-trigger"
          title={t("creator.toolbar.lists")}
          aria-label={t("creator.toolbar.lists")}
          aria-haspopup="listbox"
          aria-expanded={showListDropdown}
        >
          <List size={TOOLBAR_ICON_SIZE} />
          <ChevronDown size={TOOLBAR_ICON_SIZE} />
        </button>
      </Dropdown>

      {onImagePickerOpen && (
        <button
          type="button"
          className="toolbar-btn"
          onClick={onImagePickerOpen}
          title={t("creator.toolbar.insertImage")}
          aria-label={t("creator.toolbar.insertImage")}
        >
          <ImageIcon size={TOOLBAR_ICON_SIZE} />
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
        <RemoveFormatting size={TOOLBAR_ICON_SIZE} />
      </button>
    </div>
  );

  return placement === "inline"
    ? toolbar
    : createPortal(toolbar, document.body);
};
