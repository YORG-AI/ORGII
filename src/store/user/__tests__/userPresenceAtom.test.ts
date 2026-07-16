/**
 * Presence mode spec resolution tests.
 *
 * The wire atom must ship the FULL resolved spec (label + guidance +
 * stance + policy numbers) so the Rust side never needs to know about
 * settings or custom-role storage — any custom mode gets full runtime
 * behavior with zero backend changes.
 */
import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  presenceModeSpecResolverAtom,
  userPresenceAtom,
  userPresenceWireAtom,
} from "@src/store/user/userPresenceAtom";
import { userCustomRolesAtom } from "@src/store/user/userRolesAtom";
import {
  PRESENCE_STANCE,
  USER_PRESENCE_MODE,
  buildCustomRoleMode,
} from "@src/types/userPresence";

describe("presenceModeSpecResolver / userPresenceWireAtom", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("resolves built-in invisible with goal-mode policy defaults", () => {
    const resolve = store.get(presenceModeSpecResolverAtom);
    const spec = resolve(USER_PRESENCE_MODE.INVISIBLE);
    expect(spec).toBeDefined();
    expect(spec!.label).toBe("Invisible");
    expect(spec!.stance).toBe(PRESENCE_STANCE.AUTONOMOUS);
    expect(spec!.questionAutoResolveSecs).toBe(30);
    expect(spec!.planAutoApproveSecs).toBe(120);
    expect(spec!.goalMaxTurns).toBe(20);
    expect(spec!.modeSwitchAutoPlan).toBe(false);
    expect(spec!.builtIn).toBe(true);
  });

  it("resolves built-in online as fully interactive (everything off)", () => {
    const resolve = store.get(presenceModeSpecResolverAtom);
    const spec = resolve(USER_PRESENCE_MODE.ONLINE);
    expect(spec!.stance).toBe(PRESENCE_STANCE.INTERACTIVE);
    expect(spec!.questionAutoResolveSecs).toBe(0);
    expect(spec!.planAutoApproveSecs).toBe(0);
    expect(spec!.goalMaxTurns).toBe(0);
  });

  it("resolves a custom role with explicit policy fields", () => {
    store.set(userCustomRolesAtom, [
      {
        id: "angry",
        label: "Angry",
        iconId: "flame",
        guidance: "Be terse.",
        createdAtMs: 1,
        stance: PRESENCE_STANCE.AUTONOMOUS,
        questionAutoResolveSecs: 15,
        planAutoApproveSecs: 0,
        modeSwitchAutoPlan: true,
        goalMaxTurns: 2,
      },
    ]);
    const resolve = store.get(presenceModeSpecResolverAtom);
    const spec = resolve(buildCustomRoleMode("angry"));
    expect(spec).toBeDefined();
    expect(spec!.label).toBe("Angry");
    expect(spec!.stance).toBe(PRESENCE_STANCE.AUTONOMOUS);
    expect(spec!.questionAutoResolveSecs).toBe(15);
    expect(spec!.modeSwitchAutoPlan).toBe(true);
    expect(spec!.goalMaxTurns).toBe(2);
    expect(spec!.builtIn).toBe(false);
  });

  it("legacy custom role without policy fields stays conservative", () => {
    store.set(userCustomRolesAtom, [
      {
        id: "old-role",
        label: "Old role",
        iconId: "user",
        guidance: "Legacy guidance.",
        createdAtMs: 1,
      },
    ]);
    const resolve = store.get(presenceModeSpecResolverAtom);
    const spec = resolve(buildCustomRoleMode("old-role"));
    expect(spec!.stance).toBe(PRESENCE_STANCE.INTERACTIVE);
    expect(spec!.questionAutoResolveSecs).toBe(0);
    expect(spec!.planAutoApproveSecs).toBe(0);
    expect(spec!.modeSwitchAutoPlan).toBe(false);
    expect(spec!.goalMaxTurns).toBe(0);
  });

  it("returns undefined for a stale role id", () => {
    const resolve = store.get(presenceModeSpecResolverAtom);
    expect(resolve("role:deleted-role")).toBeUndefined();
  });

  it("wire snapshot carries the full resolved spec", () => {
    store.set(userPresenceAtom, { mode: USER_PRESENCE_MODE.INVISIBLE });
    const wire = store.get(userPresenceWireAtom);
    expect(wire).toBeDefined();
    expect(wire!.mode).toBe("invisible");
    expect(wire!.label).toBe("Invisible");
    expect(wire!.stance).toBe(PRESENCE_STANCE.AUTONOMOUS);
    expect(wire!.questionAutoResolveSecs).toBe(30);
    expect(wire!.planAutoApproveSecs).toBe(120);
    expect(wire!.modeSwitchAutoPlan).toBe(false);
    expect(wire!.goalMaxTurns).toBe(20);
  });

  it("wire snapshot for a custom mode carries the role's policy", () => {
    store.set(userCustomRolesAtom, [
      {
        id: "focus",
        label: "Focus",
        iconId: "headphones",
        guidance: "Heads down.",
        createdAtMs: 1,
        stance: PRESENCE_STANCE.DEFER_AND_BATCH,
        questionAutoResolveSecs: 60,
        planAutoApproveSecs: 0,
        modeSwitchAutoPlan: true,
        goalMaxTurns: 0,
      },
    ]);
    store.set(userPresenceAtom, { mode: buildCustomRoleMode("focus") });
    const wire = store.get(userPresenceWireAtom);
    expect(wire!.label).toBe("Focus");
    expect(wire!.guidance).toBe("Heads down.");
    expect(wire!.stance).toBe(PRESENCE_STANCE.DEFER_AND_BATCH);
    expect(wire!.questionAutoResolveSecs).toBe(60);
    expect(wire!.modeSwitchAutoPlan).toBe(true);
  });

  it("wire snapshot is undefined for a stale role mode", () => {
    store.set(userPresenceAtom, { mode: "role:ghost" });
    expect(store.get(userPresenceWireAtom)).toBeUndefined();
  });
});
