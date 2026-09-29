<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { Warning } from '@element-plus/icons-vue';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useEmergencyStore } from '../stores/emergencyStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useEmergencyWatchdog } from '../hooks/useEmergencyWatchdog';
import { estimateDraft, isCertificateExpired, rankPortsForEmergency } from '../utils/emergency';
import { expiryText } from '../utils/tonnage';
import { formatCountdown, formatDateTime } from '../utils/format';
import type { EmergencyDraft } from '../types/emergency';

useEmergencyWatchdog();

const portStore = usePortStore();
const vesselStore = useVesselStore();
const emergencyStore = useEmergencyStore();

const { draft, persist, restore, clearDraft } = useLocalDraft<EmergencyDraft>('emergency-board', () => ({
  vesselId: '',
  portId: '',
  typhoonLevel: 10,
  durationHours: 12,
  bumpConfirmed: false,
}));
const form = draft;
const formRef = ref<FormInstance>();
const submitting = ref(false);

const DURATION_OPTIONS = [6, 12, 18, 24, 36, 48, 72];

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择紧急回港渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择避风渔港', trigger: 'change' }],
  typhoonLevel: [{ required: true, message: '请填写台风等级', trigger: 'change' }],
  durationHours: [{ required: true, message: '请选择停留时长', trigger: 'change' }],
};

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));
const selectedPort = computed(() => portStore.portById(form.value.portId));

const vesselDraft = ref(0);

watch(selectedVessel, (v) => {
  if (v) vesselDraft.value = estimateDraft(v);
});

/** 港口排位（避风等级 → 水深 → 现有占用排位） */
const portRanks = computed(() => {
  if (!selectedVessel.value) return [];
  return rankPortsForEmergency(
    portStore.ports,
    portStore.berths,
    vesselDraft.value,
    Number(form.value.typhoonLevel),
  );
});

const currentRank = computed(() => portRanks.value.find((r) => r.port.id === form.value.portId) ?? null);

/** 选中渔港后，预演排位结果（将挤用哪条普通船） */
const allocationPlan = computed(() => {
  if (!selectedPort.value) return null;
  const pick = (() => {
    // 与 store 事务内同一套规则：本地预演，最终以事务复检为准
    const usable = portStore
      .berthsOf(selectedPort.value.id)
      .filter((b) => b.status !== '维修' && b.designDepth >= vesselDraft.value);
    const free = usable
      .filter((b) => b.status === '空闲')
      .sort((a, b) => a.designDepth - b.designDepth || a.berthNo.localeCompare(b.berthNo));
    if (free.length) return { berth: free[0], displaced: null };
    const bumpable = usable
      .filter((b) => b.status === '占用' && b.occupyKind !== '紧急' && b.vesselId)
      .sort(
        (a, b) =>
          new Date(b.berthAt ?? 0).getTime() - new Date(a.berthAt ?? 0).getTime() ||
          a.berthNo.localeCompare(b.berthNo),
      );
    if (bumpable.length) {
      const b = bumpable[0];
      return {
        berth: b,
        displaced: { vesselId: b.vesselId as string, vesselName: b.vesselName as string },
      };
    }
    return null;
  })();
  return pick;
});

const existingActiveStay = computed(() =>
  form.value.vesselId ? emergencyStore.activeStayOfVessel(form.value.vesselId) : undefined,
);

const certExpired = computed(() => (selectedVessel.value ? isCertificateExpired(selectedVessel.value) : false));

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!emergencyStore.stays.length) await emergencyStore.loadAll();
  restore();
  if (selectedVessel.value) vesselDraft.value = estimateDraft(selectedVessel.value);
});

watch(
  () => ({ ...form.value }),
  () => persist(),
  { deep: true },
);

watch(
  () => allocationPlan.value?.displaced?.vesselId,
  () => {
    // 排位变化后需要值班员重新确认挤用
    form.value.bumpConfirmed = false;
  },
);

function remainText(expireAt: string): string {
  return formatCountdown(new Date(expireAt).getTime() - emergencyStore.nowTick);
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  if (allocationPlan.value?.displaced && !form.value.bumpConfirmed) {
    ElMessage.warning(`该港无空闲泊位，需勾选确认挤走普通船 ${allocationPlan.value.displaced.vesselName}`);
    return;
  }
  submitting.value = true;
  try {
    const result = await emergencyStore.applyEmergency({
      vesselId: form.value.vesselId,
      portId: form.value.portId,
      typhoonLevel: Number(form.value.typhoonLevel),
      durationHours: Number(form.value.durationHours),
      vesselDraft: vesselDraft.value,
    });
    if (result.displaced) {
      ElMessage.warning(
        `已挤走普通船 ${result.displaced.vesselName}（${result.stay.portName} ${result.stay.berthNo}），改派提醒已留存`,
      );
    } else {
      ElMessage.success(
        `${result.stay.vesselName} 已紧急回港 ${result.stay.portName} ${result.stay.berthNo}，限时 ${result.stay.durationHours} 小时`,
      );
    }
    clearDraft();
    Object.assign(form.value, {
      vesselId: '',
      portId: '',
      typhoonLevel: 10,
      durationHours: 12,
      bumpConfirmed: false,
    });
  } catch (error) {
    ElMessage.error(`紧急回港失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

async function release(stayId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确认该船已驶离并释放泊位？释放后记录将保留在历史中。', '释放紧急占用', {
      type: 'warning',
      confirmButtonText: '释放',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  const stay = await emergencyStore.releaseStay(stayId, '手动释放');
  if (stay) ElMessage.success(`${stay.vesselName} 已驶离，${stay.portName} ${stay.berthNo} 已释放`);
}

async function acknowledgeAll(): Promise<void> {
  await emergencyStore.markAllNoticesRead();
  ElMessage.success('改派提醒已全部阅知');
}

const activeRows = computed(() =>
  emergencyStore.activeStays.map((s) => ({
    ...s,
    remain: remainText(s.expireAt),
    overdue: new Date(s.expireAt).getTime() <= emergencyStore.nowTick,
  })),
);
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>台风紧急回港</h1>
        <p class="page__sub">
          值班员选定避风渔港与停留时长，按避风等级、水深与现有占用排位安排限时占用；证书过期船只可避险但不得长占，到期自动释放
        </p>
      </div>
      <el-badge :value="emergencyStore.unreadNotices.length" :hidden="!emergencyStore.unreadNotices.length" type="danger">
        <el-tag type="warning" effect="dark" size="large">
          <el-icon><Warning /></el-icon>
          生效中 {{ emergencyStore.activeStays.length }} 条
        </el-tag>
      </el-badge>
    </header>

    <el-alert
      type="warning"
      show-icon
      :closable="false"
      title="紧急回港为限时占用：只用于台风避险，普通进港的证书校验在此通道豁免；到期自动释放泊位并保留全程记录"
      data-testid="emergency-banner"
    />

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">紧急回港申报</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="100px" data-testid="emergency-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select
                id="em-vessel"
                v-model="form.vesselId"
                placeholder="选择需要回港避险的渔船（含证书过期船）"
                filterable
                style="width: 100%"
              >
                <el-option
                  v-for="v in vesselStore.vessels"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · 吃水估 ${estimateDraft(v)}m · 证书 ${v.certificateExpiry}）`"
                  :value="v.id"
                >
                  <span>{{ v.name }}</span>
                  <el-tag
                    size="small"
                    :type="isCertificateExpired(v) ? 'danger' : 'success'"
                    effect="plain"
                    style="margin-left: 8px"
                  >
                    证书{{ isCertificateExpired(v) ? '已过期' : '有效' }}
                  </el-tag>
                </el-option>
              </el-select>
            </el-form-item>

            <el-alert
              v-if="selectedVessel && certExpired"
              type="error"
              show-icon
              :closable="false"
              class="cert-alert"
              data-testid="cert-expired-alert"
              :title="`证书已于 ${selectedVessel.certificateExpiry} 过期（${expiryText(selectedVessel.certificateExpiry)}）：普通进港拦截，本通道仅允许限时避险`"
            />
            <el-alert
              v-else-if="selectedVessel"
              type="success"
              show-icon
              :closable="false"
              class="cert-alert"
              :title="`证书有效（${expiryText(selectedVessel.certificateExpiry)}），紧急通道同样适用`"
            />

            <el-form-item label="台风等级" prop="typhoonLevel">
              <el-input-number id="em-level" v-model="form.typhoonLevel" :min="6" :max="17" :step="1" />
              <span class="form-hint">渔港避风能力须 ≥ {{ form.typhoonLevel }} 级才可接纳</span>
            </el-form-item>

            <el-form-item label="避风渔港" prop="portId">
              <el-radio-group v-model="form.portId" class="port-rank" data-testid="em-port-radio">
                <label
                  v-for="rank in portRanks"
                  :key="rank.port.id"
                  class="port-rank__item"
                  :class="{ 'port-rank__item--disabled': !rank.available }"
                >
                  <el-radio :value="rank.port.id" :disabled="!rank.available">
                    <span class="port-rank__name">{{ rank.port.name }}</span>
                    <el-tag size="small" :type="rank.port.shelterLevel >= form.typhoonLevel ? 'success' : 'info'">
                      抗风 {{ rank.port.shelterLevel }} 级
                    </el-tag>
                    <el-tag size="small" type="info" effect="plain">水深 {{ rank.maxDepth }}m</el-tag>
                    <el-tag size="small" :type="rank.freeCount ? 'success' : rank.bumpableCount ? 'warning' : 'danger'">
                      空闲 {{ rank.freeCount }} · 可挤 {{ rank.bumpableCount }}
                    </el-tag>
                  </el-radio>
                </label>
              </el-radio-group>
              <p v-if="!portRanks.length" class="form-hint">没有渔港能达到 {{ form.typhoonLevel }} 级避风要求</p>
            </el-form-item>

            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="估算吃水 m">
                  <el-input-number id="em-draft" v-model="vesselDraft" :min="1" :max="20" :step="0.1" :precision="1" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="停留时长 h" prop="durationHours">
                  <el-select id="em-duration" v-model="form.durationHours" style="width: 100%">
                    <el-option v-for="h in DURATION_OPTIONS" :key="h" :label="`${h} 小时`" :value="h" />
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>

            <el-alert
              v-if="currentRank && allocationPlan && !allocationPlan.displaced"
              type="success"
              show-icon
              :closable="false"
              data-testid="plan-free"
              :title="`排位结果：占用空闲泊位 ${allocationPlan.berth.berthNo}（水深 ${allocationPlan.berth.designDepth}m），不影响其他船`"
            />
            <el-alert
              v-else-if="currentRank && allocationPlan?.displaced"
              type="warning"
              show-icon
              :closable="false"
              data-testid="plan-bump"
              class="bump-alert"
            >
              <template #title>
                排位结果：港内无空闲泊位，将挤掉现有占用排位最末的普通船
                <b>{{ allocationPlan.displaced.vesselName }}</b>（泊位 {{ allocationPlan.berth.berthNo }}）
              </template>
              <el-checkbox v-model="form.bumpConfirmed" data-testid="bump-confirm">
                值班员确认挤走该普通船并向其发送改派提醒
              </el-checkbox>
            </el-alert>
            <el-alert
              v-else-if="currentRank"
              type="error"
              show-icon
              :closable="false"
              data-testid="plan-none"
              title="该港没有水深适配且可使用的泊位，且紧急船之间不可互挤，请改选其他渔港"
            />

            <el-alert
              v-if="existingActiveStay"
              type="error"
              show-icon
              :closable="false"
              data-testid="dup-stay-alert"
              :title="`${existingActiveStay.vesselName} 已在 ${existingActiveStay.portName} ${existingActiveStay.berthNo} 持有生效中的紧急占用，重复提交不会多占`"
            />

            <el-form-item>
              <el-button
                type="primary"
                :loading="submitting"
                :disabled="!!existingActiveStay"
                data-testid="submit-emergency"
                @click="submit"
              >
                办理紧急回港
              </el-button>
              <el-button text @click="clearDraft(); ElMessage.success('草稿已清空')">清空</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">生效中的限时占用（{{ activeRows.length }}）</span>
          </template>
          <el-table :data="activeRows" size="small" border empty-text="当前无紧急占用" data-testid="active-stays">
            <el-table-column prop="vesselName" label="船名" min-width="120" />
            <el-table-column prop="portName" label="渔港" min-width="110" />
            <el-table-column prop="berthNo" label="泊位" width="70" />
            <el-table-column label="到期倒计时" min-width="130">
              <template #default="scope">
                <el-tag size="small" :type="scope.row.overdue ? 'danger' : 'warning'" data-testid="countdown">
                  {{ scope.row.remain }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="scope">
                <el-button text type="primary" size="small" data-testid="release-stay" @click="release(scope.row.id)">
                  释放
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">
              改派提醒（{{ emergencyStore.unreadNotices.length }} 条未阅）
            </span>
            <el-button
              v-if="emergencyStore.unreadNotices.length"
              text
              type="primary"
              size="small"
              style="float: right"
              data-testid="notice-read-all"
              @click="acknowledgeAll"
            >
              全部阅知
            </el-button>
          </template>
          <el-timeline v-if="emergencyStore.noticesSorted.length" data-testid="notice-list">
            <el-timeline-item
              v-for="n in emergencyStore.noticesSorted"
              :key="n.id"
              :timestamp="formatDateTime(n.displacedAt)"
              :type="n.read ? 'info' : 'danger'"
              placement="top"
            >
              <div class="notice-row" :class="{ 'notice-row--read': n.read }">
                <el-tag size="small" :type="n.read ? 'info' : 'danger'">{{ n.read ? '已阅' : '待改派' }}</el-tag>
                <span>{{ n.suggestion }}</span>
                <el-button
                  v-if="!n.read"
                  text
                  type="primary"
                  size="small"
                  @click="emergencyStore.markNoticeRead(n.id)"
                >
                  阅知
                </el-button>
              </div>
            </el-timeline-item>
          </el-timeline>
          <el-empty description="暂无被挤走船只的改派提醒" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">历史紧急占用（释放后保留，{{ emergencyStore.historyStays.length }} 条）</span></template>
      <el-table :data="emergencyStore.historyStays" size="small" border empty-text="暂无历史记录" data-testid="stay-history">
        <el-table-column prop="vesselName" label="船名" min-width="120" />
        <el-table-column prop="portName" label="渔港" min-width="110" />
        <el-table-column prop="berthNo" label="泊位" width="70" />
        <el-table-column label="靠泊时间" min-width="140">
          <template #default="scope">{{ formatDateTime(scope.row.startAt) }}</template>
        </el-table-column>
        <el-table-column label="到期时间" min-width="140">
          <template #default="scope">{{ formatDateTime(scope.row.expireAt) }}</template>
        </el-table-column>
        <el-table-column label="释放时间" min-width="140">
          <template #default="scope">{{ formatDateTime(scope.row.releasedAt) }}</template>
        </el-table-column>
        <el-table-column label="释放原因" width="100">
          <template #default="scope">
            <el-tag size="small" :type="scope.row.releaseReason === '超时释放' ? 'danger' : 'info'">
              {{ scope.row.releaseReason }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挤走的普通船" min-width="120">
          <template #default="scope">{{ scope.row.displacedVesselName ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="申报时证书" width="110">
          <template #default="scope">
            <el-tag size="small" :type="scope.row.certificateExpired ? 'danger' : 'success'">
              {{ scope.row.certificateExpired ? '已过期' : '有效' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.cert-alert,
.bump-alert {
  margin-bottom: 16px;
}
.form-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #8592a0;
}
.port-rank {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.port-rank__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid #e7eef5;
  border-radius: 8px;
  margin: 0;
}
.port-rank__item--disabled {
  opacity: 0.55;
}
.port-rank__name {
  font-weight: 600;
  color: #17324d;
  margin-right: 4px;
}
.notice-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.notice-row--read {
  opacity: 0.65;
}
</style>
