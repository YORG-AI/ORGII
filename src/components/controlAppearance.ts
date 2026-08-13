/**
 * Shared visual treatment vocabulary for interactive controls.
 *
 * `ghost` controls are transparent at rest and gain the shared hover/focus
 * surface. Fields additionally support `bare` for permanently chromeless
 * editor and search internals.
 */
export type ControlAppearance = "default" | "ghost";

export type FieldAppearance = ControlAppearance | "bare";

export type BareControlAppearance = Exclude<FieldAppearance, "ghost">;
