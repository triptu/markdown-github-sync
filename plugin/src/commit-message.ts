export const defaultCommitMessageTemplate = "vault backup {{device}} ({{count}}): {{date}}";
export const defaultCommitDateFormat = "Do MMM, YYYY HH:mm:ss";

/** Local device time, with bracketed literals like Moment's date formats. */
export function formatCommitMessage(
  template: string,
  dateFormat: string,
  context: { device: string; count: number; date: Date },
): string {
  const date = context.date;
  const day = date.getDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th"
    : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  const pad = (value: number) => String(value).padStart(2, "0");
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()), MM: pad(date.getMonth() + 1),
    MMM: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()],
    D: String(day), DD: pad(day), Do: `${day}${suffix}`,
    HH: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()),
  };
  const formatted = dateFormat.replace(/\[([^\]]*)\]|YYYY|MMM|MM|Do|DD|D|HH|mm|ss/g,
    (token: string, literal: string | undefined) => literal ?? tokens[token] ?? token);
  return template.replace(/\{\{(device|hostname|count|numFiles|date)\}\}/g, (_token: string, key: string) =>
    key === "device" || key === "hostname" ? context.device
      : key === "count" || key === "numFiles" ? String(context.count) : formatted);
}
