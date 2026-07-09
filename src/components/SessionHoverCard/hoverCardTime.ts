export function formatHoverCardTimeAgo(
  dateString: string,
  language: string
): string {
  const timestamp = new Date(dateString).getTime();
  if (Number.isNaN(timestamp)) return "";

  const diffMs = timestamp - Date.now();
  const diffDay = Math.round(diffMs / (24 * 60 * 60 * 1000));
  const diffMonth = Math.round(diffDay / 30);
  const diffYear = Math.round(diffDay / 365);
  const formatter = new Intl.RelativeTimeFormat(language, {
    numeric: "auto",
    style: "narrow",
  });

  if (Math.abs(diffDay) < 30) return formatter.format(diffDay, "day");
  if (Math.abs(diffMonth) < 12) return formatter.format(diffMonth, "month");
  return formatter.format(diffYear, "year");
}
