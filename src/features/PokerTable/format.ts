import { TOKENS_PER_CHIP } from "./engine/types";

/**
 * Chips → short token label the way the table prints them: `561K`,
 * `1.28M`, `35.8M`, `106M`. Precision shrinks as the mantissa grows so
 * seat pills stay narrow (the usage dashboard's axis rule).
 */
export function formatChips(chips: number): string {
  const tokens = Math.max(0, Math.round(chips)) * TOKENS_PER_CHIP;
  if (tokens === 0) return "0";
  const units = [
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" },
  ] as const;
  const unit = units.find((candidate) => tokens >= candidate.threshold);
  if (!unit) return String(tokens);
  const scaled = tokens / unit.threshold;
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const text = scaled.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");
  return `${text}${unit.suffix}`;
}

/** Stakes label for the header: `0.5/1`. */
export function formatStakes(smallBlind: number, bigBlind: number): string {
  const millions = (chips: number) =>
    String(Math.round(((chips * TOKENS_PER_CHIP) / 1e6) * 100) / 100);
  return `${millions(smallBlind)}/${millions(bigBlind)}`;
}
