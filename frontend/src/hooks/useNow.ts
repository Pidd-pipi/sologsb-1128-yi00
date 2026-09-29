import { onBeforeUnmount, ref } from 'vue';

/**
 * 每 intervalMs 跳动一次的当前时间（毫秒时间戳），供限时占用倒计时与超时判断使用。
 * 多个组件共用同一个定时器，避免重复 setInterval。
 */
const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

const DEFAULT_INTERVAL = 30_000;

function ensureTimer(intervalMs: number): void {
  refCount += 1;
  if (timer === null) {
    nowMs.value = Date.now();
    timer = setInterval(() => {
      nowMs.value = Date.now();
    }, intervalMs);
  }
}

function releaseTimer(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function useNow(intervalMs: number = DEFAULT_INTERVAL) {
  ensureTimer(intervalMs);
  onBeforeUnmount(releaseTimer);

  /** 紧急占用剩余分钟（传入 expiresAt ISO 字符串） */
  function remainingMinutesOf(expiresAt: string | null | undefined): number {
    if (!expiresAt) return 0;
    return Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs.value) / 60000));
  }

  /** 是否已过期 */
  function isPast(iso: string | null | undefined): boolean {
    if (!iso) return false;
    return new Date(iso).getTime() <= nowMs.value;
  }

  return { nowMs, remainingMinutesOf, isPast };
}
