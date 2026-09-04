import { atomWithStorage } from "jotai/utils";

import {
  CREATOR_COMPOSER_POSITION,
  type CreatorComposerPosition,
} from "@src/config/sessionCreatorConfig";

/**
 * Shared input placement across session, work-item, project, and other creators.
 * User changes go through changeCreatorComposerPositionAtom to reset the trail.
 */
export const creatorComposerPositionAtom =
  atomWithStorage<CreatorComposerPosition>(
    "orgii:newChat:composerPosition",
    CREATOR_COMPOSER_POSITION.BOTTOM,
    undefined,
    { getOnInit: true }
  );
creatorComposerPositionAtom.debugLabel = "creatorComposerPositionAtom";
