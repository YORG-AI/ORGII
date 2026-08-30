import type { IndexedComponentLocation } from "./types";

export function isDefinitionKind(
  kind: IndexedComponentLocation["kind"]
): boolean {
  return [
    "function_def",
    "arrow_def",
    "class_def",
    "vue_def",
    "svelte_def",
  ].includes(kind);
}

export function scoreComponentLocation(
  location: IndexedComponentLocation,
  componentName: string
): number {
  let score = 0;
  const lowerName = componentName.toLowerCase();

  if (isDefinitionKind(location.kind)) {
    score += 1000;
  }

  if (location.kind === "function_def" || location.kind === "arrow_def") {
    score += 200;
  }

  const filename = location.file.split("/").pop() || "";
  const filenameWithoutExt = filename
    .replace(/\.(tsx?|jsx?)$/i, "")
    .toLowerCase();

  if (filenameWithoutExt === lowerName) {
    score += 500;
  } else if (filenameWithoutExt === "index") {
    const pathParts = location.file.split("/");
    const folderName = pathParts[pathParts.length - 2]?.toLowerCase() || "";
    if (folderName === lowerName) {
      score += 450;
    }
  }

  if (location.file.toLowerCase().includes("/components/")) {
    score += 100;
  }

  if (location.file.includes("node_modules")) {
    score -= 5000;
  }

  return score;
}
