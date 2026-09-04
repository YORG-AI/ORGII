/**
 * WCAG 2.0 relative luminance calculation.
 *
 * Shared between useContrastJs and toolbarTheme.
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
export function getRelativeLuminance(
  red: number,
  green: number,
  blue: number
): number {
  const [rs, gs, bs] = [red, green, blue].map((val) => {
    const normalized = val / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
