/**
 * Journey Station selection state.
 *
 * The Journey station is a first-class workstation surface (peer of Ops
 * Control) hosting both Project Journeys and Session Journeys. Selection is
 * in-memory only: journeys are read-only fact views, so there is nothing
 * worth persisting across reloads ("startup must be inert").
 */
import { atom } from "jotai";

export interface JourneyStationSelection {
  kind: "project" | "session";
  /** Project id/slug or session id, matching `JourneyScope` identity. */
  id: string;
  /** Display name for the Journey header (optional). */
  name?: string;
}

export const journeyStationSelectionAtom =
  atom<JourneyStationSelection | null>(null);
journeyStationSelectionAtom.debugLabel = "journeyStationSelectionAtom";
