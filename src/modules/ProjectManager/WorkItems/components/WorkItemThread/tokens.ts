import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";

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
    "mb-0! h-10! border-b border-border-1 bg-primary-container px-3",
  contentColumn: `${DETAIL_PANEL_TOKENS.headerWidth} flex flex-col`,
  flowHeader: DETAIL_PANEL_TOKENS.flowHeaderPadding,
  // Sits above the flow header, so it keeps the header's horizontal inset but
  // owns the top padding the header would otherwise contribute.
  alerts: "flex flex-col gap-2 px-4 pt-4",
  contentBody: `flex flex-col gap-3 ${DETAIL_PANEL_TOKENS.threadContentPadding} pb-24`,
  metadataBand:
    "flex min-w-0 items-center gap-2 overflow-x-auto scrollbar-hide",
} as const;
