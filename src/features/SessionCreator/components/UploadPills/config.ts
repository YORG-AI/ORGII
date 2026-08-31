/**
 * UploadPills Configuration
 */
import {
  ArchiveIcon,
  CodeXmlIcon,
  File01Icon,
  File02Icon,
  FolderClosedIcon,
  type IconSvgElement,
  Image01Icon,
  SheetIcon,
} from "@src/icons";

// ============================================
// Icon Configuration
// ============================================

const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
];

/**
 * Get file type icon component based on file name and type
 */
export const getFileTypeIcon = (
  fileName: string,
  fileType: string
): IconSvgElement => {
  const ext = fileName.split(".").pop()?.toLowerCase();

  if (fileType === "image" || IMAGE_EXTENSIONS.includes(ext || "")) {
    return Image01Icon;
  }

  // Document files
  if (["pdf"].includes(ext || "")) {
    return File02Icon; // PDF icon - using FileText as closest match
  }
  if (["doc", "docx"].includes(ext || "")) {
    return File02Icon; // Word document
  }
  if (["xls", "xlsx", "numbers"].includes(ext || "")) {
    return SheetIcon; // Excel/Spreadsheet
  }
  if (["ppt", "pptx"].includes(ext || "")) {
    return File02Icon; // PowerPoint - using FileText as closest match
  }

  // Code files
  if (
    [
      "js",
      "ts",
      "jsx",
      "tsx",
      "py",
      "java",
      "c",
      "cpp",
      "h",
      "rs",
      "go",
    ].includes(ext || "")
  ) {
    return CodeXmlIcon;
  }

  // Text files
  if (["txt", "md", "json", "xml", "yaml", "yml"].includes(ext || "")) {
    return File02Icon;
  }

  // Archive files
  if (["zip", "tar", "gz", "rar", "7z"].includes(ext || "")) {
    return ArchiveIcon;
  }

  // Folder
  if (fileType === "folder") {
    return FolderClosedIcon;
  }

  // Default file icon
  return File01Icon;
};

// ============================================
// Style Configuration
// ============================================

export const STYLE_CONFIG = {
  /** Maximum width for file name before truncation */
  maxNameWidth: "120px",
  /** Pill border radius */
  borderRadius: "8px",
  /** Pill padding */
  padding: "8px 12px",
  /** Gap between pills */
  gap: "8px",
} as const;
