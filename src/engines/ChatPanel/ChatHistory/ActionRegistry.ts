/**
 * Action Registry
 *
 * Chat context component mappings from unified registry.
 *
 * Imports the pure metadata module directly (not the registry barrel): this
 * file sits on the chat-projection worker's static import path, and the
 * barrel re-exports `events/index.ts`, whose lazy renderer `import()`s would
 * otherwise become part of the worker's bundle graph and force webpack to
 * duplicate every shared vendor module into the async chunks.
 */

export {
  getActionConfig,
  requiresItemIndex,
  shouldShowStatusLine,
} from "@src/engines/SessionCore/rendering/registry/events/contextConfig";
