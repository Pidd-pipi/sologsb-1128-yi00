/**
 * 通用格式化 / 脱代理工具。
 */

/**
 * 脱代理深拷贝：Pinia 中的响应式对象（Proxy）直接写 IndexedDB 会抛
 * DataCloneError（表现为保存静默失败 + 1 条 console error），写库前必须经过它。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 生成带前缀的唯一 id */
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO 字符串 → 2025-03-08 14:20 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 字符串 → 2025-03-08 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 数值格式化，默认保留 1 位小数 */
export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits);
}

/** 0-1 的占用率 → 62.5% */
export function percentText(rate: number): string {
  if (!Number.isFinite(rate)) return '0%';
  return `${(rate * 100).toFixed(1)}%`;
}

/** Date → datetime-local 输入框可用的值（YYYY-MM-DDTHH:mm） */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 当前时间对应的 datetime-local 输入值 */
export function nowLocalInputValue(): string {
  return toLocalInputValue(new Date());
}

/** 判断 ISO 时间是否落在今天 */
export function isToday(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** 两个 ISO 时间是否属于同一天 */
export function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const dbDate = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(dbDate.getTime())) return false;
  return da.getFullYear() === dbDate.getFullYear() && da.getMonth() === dbDate.getMonth() && da.getDate() === dbDate.getDate();
}

/** 剩余毫秒 → 「12 时 05 分」/「03 分 20 秒」/「已超时 02 分」 */
export function formatCountdown(ms: number): string {
  const overdue = ms < 0;
  const totalMin = Math.floor(Math.abs(ms) / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const seconds = Math.floor((Math.abs(ms) % 60000) / 1000);
  let text: string;
  if (hours > 0) text = `${hours} 时 ${pad(minutes)} 分`;
  else if (totalMin > 0) text = `${totalMin} 分 ${pad(seconds)} 秒`;
  else text = `${seconds} 秒`;
  return overdue ? `已超时 ${text}` : `剩余 ${text}`;
}
