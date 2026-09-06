/**
 * Marker class for brand artwork that the monochrome icon setting desaturates.
 *
 * Applied to icons whose colors come from a third-party palette (file-type
 * glyphs, provider/model logos) rather than from `currentColor`. Icons that
 * already inherit the text color need no marker — they are monochrome by
 * construction and would only pick up a redundant filter.
 *
 * The matching rules live in `src/styles/_decorative-icons.scss`.
 */
export const DECORATIVE_ICON_CLASS = "orgii-decorative-icon";
