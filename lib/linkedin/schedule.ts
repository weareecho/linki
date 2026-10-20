export interface AccountSchedule {
  active_hours_start: number; active_hours_end: number; timezone: string; working_days: string;
}

/** Choose a future instant inside the account's local work window. Container
 * timezone must not influence enrollment, weekend rollover or daily-cap delays. */
export function nextAccountSlot(account: AccountSchedule, options: { now?: Date; nextDay?: boolean; fraction?: number } = {}): string {
  const now = options.now || new Date();
  const zone = account.timezone || "UTC";
  const start = account.active_hours_start ?? 9, end = account.active_hours_end ?? 18;
  const days = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  if (!(start >= 0 && start < end && end <= 24) || !days.some(d => d >= 1 && d <= 7)) throw new Error("Invalid account work schedule");
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (date: Date) => {
    const values = Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]));
    return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute, second: +values.second };
  };
  const local = parts(now);
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  const instant = (civil: number) => {
    let candidate = civil;
    for (let n = 0; n < 4; n++) {
      const p = parts(new Date(candidate));
      const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      const next = candidate + civil - rendered;
      if (next === candidate) break;
      candidate = next;
    }
    return candidate;
  };
  const fraction = Math.min(0.999999999, Math.max(0, options.fraction ?? Math.random()));
  for (let offset = options.nextDay ? 1 : 0; offset <= 14; offset++) {
    const civil = localMidnight + offset * 86_400_000;
    const weekday = new Date(civil).getUTCDay() || 7;
    if (!days.includes(weekday)) continue;
    const lower = Math.max(now.getTime() + 1, instant(civil + start * 3600_000));
    const upper = instant(civil + end * 3600_000);
    if (upper > lower) return new Date(Math.floor(lower + fraction * (upper - lower))).toISOString();
  }
  throw new Error("No future account work window found");
}
