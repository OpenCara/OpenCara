const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelative(iso: string | Date): string {
  const ts = iso instanceof Date ? iso : new Date(iso);
  const diff = (ts.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return RTF.format(Math.round(diff), "second");
  if (abs < 3600) return RTF.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return RTF.format(Math.round(diff / 86400), "day");
  return ts.toLocaleDateString();
}

export function formatAbsolute(iso: string | Date): string {
  const ts = iso instanceof Date ? iso : new Date(iso);
  return ts.toLocaleString();
}

export function formatDayHeader(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}
