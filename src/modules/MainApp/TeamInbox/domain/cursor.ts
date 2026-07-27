/**
 * Encodes a Team Inbox cursor item key into the backend cursor `itemId`.
 *
 * The local read model's cursor already carries the backend source id
 * (`work_item_assigned:<workItemId>`), and the Rust `list_page` command strips
 * that `work_item_assigned:` source prefix itself. Only the UI kind prefix
 * (`assigned_work_item:`) — if a UI item key is passed by mistake — must be
 * removed here. The `work_item_assigned:` source prefix MUST be preserved, or
 * the backend rejects the cursor with "Unsupported Team Inbox cursor item id".
 */
export function toWireCursorItemId(itemKey: string): string {
  return itemKey.replace(/^assigned_work_item:/, "");
}
