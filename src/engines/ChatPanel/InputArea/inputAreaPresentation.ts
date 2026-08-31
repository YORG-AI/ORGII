export type InputAreaPresentation = "default" | "contextual";

export function isContextualInputAreaPresentation(
  presentation: InputAreaPresentation
): boolean {
  return presentation === "contextual";
}
