/** Cache-registry values: KB granularity below 1 MB, MB above. */
export function formatCacheBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 10) return `${megabytes.toFixed(0)} MB`;
  return `${megabytes.toFixed(1)} MB`;
}

export function formatMegabytes(megabytes: number): string {
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(2)} GB`;
  return `${megabytes.toFixed(1)} MB`;
}
