/**
 * Chat adapters — one file per `ChatBlock` variant.
 *
 * Each adapter wraps a Block component, pulling pre-translated labels
 * from the Rust tool registry (`useLifecycleLabels` / `useToolLabelText`)
 * and handing them to the Block. Blocks never touch i18n keys directly.
 *
 * `CHAT_BLOCKS` in `../chatBlocks.ts` maps each `ChatBlock` variant to
 * exactly one of these adapters.
 */
export { CanvasInlineAdapter } from "./CanvasInlineAdapter";
export { DiffAdapter } from "./DiffAdapter";
export { ExploreAdapter } from "./ExploreAdapter";
export { FallbackAdapter } from "./FallbackAdapter";
export { GlobAdapter } from "./GlobAdapter";
export { OrgTaskAdapter, orgTaskItemToCardData } from "./OrgTaskAdapter";
export { PlanDocAdapter } from "./PlanDocAdapter";
export { ReadFileAdapter } from "./ReadFileAdapter";
export { SearchAdapter } from "./SearchAdapter";
export { SetupRepoAdapter } from "./SetupRepoAdapter";
export { OrgSendMessageBlock, SentMessageAdapter } from "./SentMessageAdapter";
export { ShellAdapter } from "./ShellAdapter";
export { SubagentAdapter } from "./SubagentAdapter";
export { TitleOnlyAdapter } from "./TitleOnlyAdapter";
export { TodoAdapter } from "./TodoAdapter";
export { WebSearchAdapter } from "./WebSearchAdapter";
