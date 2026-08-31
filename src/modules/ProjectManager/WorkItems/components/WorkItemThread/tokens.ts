export const WORK_ITEM_THREAD_TOKENS = {
  card: "overflow-hidden rounded-xl border border-border-1 bg-chat-pane",
  cardHeader:
    "flex min-h-10 items-center justify-between gap-3 border-b border-border-1 bg-primary-container px-3 py-2",
  cardBody: "bg-chat-pane px-3 py-2",
  alignedRowPadding: "px-0 py-1",
  leadingIconSlot: "flex h-6 w-5 shrink-0 items-center justify-center",
  trailingActionSlot: "flex h-6 w-6 shrink-0 items-center justify-center",
  emptyActionRow: "flex min-h-8 items-center justify-between gap-2 py-1",
  collapsibleHeader:
    "!mb-0 !h-10 border-b border-border-1 bg-primary-container px-3",
  contentColumn:
    "mx-auto flex w-full max-w-[920px] flex-col gap-3 px-5 py-5 pb-24",
  metadataBand:
    "flex min-w-0 items-center gap-2 overflow-x-auto scrollbar-hide",
} as const;
