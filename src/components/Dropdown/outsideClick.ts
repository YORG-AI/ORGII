export function subscribeToDropdownOutsideMouseDown(
  ownerDocument: Document,
  listener: (event: MouseEvent) => void
): () => void {
  ownerDocument.addEventListener("mousedown", listener, true);
  return () => ownerDocument.removeEventListener("mousedown", listener, true);
}
