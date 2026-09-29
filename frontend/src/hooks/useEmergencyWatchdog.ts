import { onMounted } from 'vue';
import { useEmergencyStore } from '../stores/emergencyStore';

const SWEEP_INTERVAL_MS = 20_000;
const TICK_INTERVAL_MS = 1_000;

let timerStarted = false;

/**
 * 紧急占用看门狗：每秒刷新一次倒计时时钟，每 20s 扫描一次到期占用并自动释放。
 * 全局只启动一份（store 为单例，重复挂载幂等）。
 */
export function useEmergencyWatchdog(): void {
  const emergencyStore = useEmergencyStore();

  onMounted(() => {
    // 首次挂载先把紧急占用与改派提醒载入内存（store 已有数据时 loadAll 为廉价刷新）
    if (!emergencyStore.stays.length && !emergencyStore.notices.length) {
      void emergencyStore.loadAll().then(() => void emergencyStore.sweepExpired());
    } else {
      void emergencyStore.sweepExpired();
    }
    if (timerStarted) return;
    timerStarted = true;
    window.setInterval(() => {
      emergencyStore.nowTick = Date.now();
    }, TICK_INTERVAL_MS);
    window.setInterval(() => {
      void emergencyStore.sweepExpired();
    }, SWEEP_INTERVAL_MS);
  });
}
