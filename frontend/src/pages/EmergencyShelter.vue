<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useNow } from '../hooks/useNow';
import EmptyState from '../components/common/EmptyState.vue';
import { SHELTER_DURATIONS, emptyShelterDraft, type ShelterDraft } from '../types/shelter';
import { daysUntilExpiry } from '../utils/tonnage';
import { formatDateTime, formatNumber } from '../utils/format';
import {
  isCertificateExpired,
  portCanWithstand,
  rankBerthCandidates,
  requiredDepthM,
} from '../utils/shelter';
import type { Berth } from '../types/berth';

interface ShelterForm extends ShelterDraft {}

const portStore = usePortStore();
const vesselStore = useVesselStore();
const { draft, storageKey, persist, restore, clearDraft } = useLocalDraft<ShelterForm>('emergency-shelter', () => ({
  ...emptyShelterDraft(),
}));
const form = draft;

const { nowMs, remainingMinutesOf } = useNow();

const formRef = ref<FormInstance>();
const submitting = ref(false);
const sweepHint = ref('');

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择紧急回港渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择避风渔港', trigger: 'change' }],
  berthNo: [{ required: true, message: '请选择避风泊位', trigger: 'change' }],
  typhoonLevel: [{ required: true, message: '请填写台风等级', trigger: 'change' }],
  durationHours: [{ required: true, message: '请选择停留时长', trigger: 'change' }],
};

const vesselOptions = computed(() => vesselStore.vessels);
const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));
const selectedPort = computed(() => portStore.portById(form.value.portId));

const vesselExpired = computed(() => (selectedVessel.value ? isCertificateExpired(selectedVessel.value) : false));
const vesselExpiryDays = computed(() =>
  selectedVessel.value ? daysUntilExpiry(selectedVessel.value.certificateExpiry) : Number.NaN,
);

const requiredDepth = computed(() => (selectedVessel.value ? requiredDepthM(selectedVessel.value) : 0));

const typhoonOptions = [8, 9, 10, 11, 12, 13, 14, 15];

const portShelterOk = computed(() =>
  selectedPort.value ? portCanWithstand(selectedPort.value, form.value.typhoonLevel) : true,
);

/** 选定渔港 + 渔船后的候选泊位排位（含可挤掉的普通占用） */
const candidates = computed(() => {
  if (!selectedPort.value || !selectedVessel.value) return [];
  return rankBerthCandidates(portStore.berthsOf(selectedPort.value.id), requiredDepth.value);
});

/** 不可选泊位（维修 / 紧急占用 / 水深不足），用于说明排位结果 */
const blockedBerths = computed(() => {
  if (!selectedPort.value || !selectedVessel.value) return [];
  const usableIds = new Set(candidates.value.map((c) => c.berth.id));
  return portStore.berthsOf(selectedPort.value.id)
    .filter((b) => !usableIds.has(b.id))
    .map((b) => {
      let reason = '不可用';
      if (b.status === '维修') reason = '维修中';
      else if (b.occupancyKind === '紧急') reason = `紧急船 ${b.vesselName ?? ''} 限时占用中`;
      else if (b.designDepth + 1e-9 < requiredDepth.value) reason = `水深 ${formatNumber(b.designDepth)}m 不足`;
      return { berth: b, reason };
    });
});

const selectedCandidate = computed(() => candidates.value.find((c) => c.berth.berthNo === form.value.berthNo) ?? null);
/** 候选泊位上是其他普通船（需要挤掉并生成改派提醒） */
const willDisplace = computed(
  () =>
    Boolean(selectedCandidate.value?.occupant) &&
    selectedCandidate.value!.occupant!.vesselId !== selectedVessel.value?.id,
);
/** 候选泊位本就由本船普通占用（普通占用转紧急，不算挤掉别人） */
const willUpgradeOwn = computed(
  () =>
    Boolean(selectedCandidate.value?.occupant) &&
    selectedCandidate.value!.occupant!.vesselId === selectedVessel.value?.id,
);
const ownActiveShelter = computed(() =>
  selectedVessel.value ? portStore.activeShelterOfVessel(selectedVessel.value.id) : undefined,
);

const activeShelters = computed(() => portStore.activeShelters);
const historyShelters = computed(() => portStore.shelterHistory.slice(0, 20));
const pendingNotices = computed(() => portStore.pendingNotices);

function expiryTagType(): 'danger' | 'warning' | 'success' | 'info' {
  const days = vesselExpiryDays.value;
  if (Number.isNaN(days)) return 'info';
  if (days < 0) return 'danger';
  if (days <= 90) return 'warning';
  return 'success';
}

function expiryText(): string {
  const days = vesselExpiryDays.value;
  if (Number.isNaN(days)) return '证书日期无效';
  if (days < 0) return `证书已过期 ${Math.abs(days)} 天`;
  if (days <= 90) return `证书 ${days} 天后到期`;
  return `证书有效（剩 ${days} 天）`;
}

function countdownText(expiresAt: string): string {
  const mins = remainingMinutesOf(expiresAt);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} 小时 ${String(m).padStart(2, '0')} 分`;
}

function hasContent(value: ShelterForm): boolean {
  return Boolean(value.vesselId) || Boolean(value.portId) || Boolean(value.berthNo);
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  restore();
  if (!hasContent(form.value)) clearDraft();
  await runSweep('启动');
});

watch(
  () => ({ ...form.value }),
  (value) => {
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

// 时钟每 30s 跳一次：自动扫描并释放超时占用，界面倒计时同步刷新
watch(nowMs, () => {
  void runSweep('定时');
});

// 切换渔港时重置泊位（不同渔港泊位号可能相同）
watch(
  () => form.value.portId,
  () => {
    form.value.berthNo = '';
  },
);

// 切换渔船（吃水需求变化）或台风等级后，已选泊位若被排除出新排位则清空
watch(
  () => [form.value.vesselId, form.value.typhoonLevel],
  () => {
    if (form.value.berthNo && !candidates.value.some((c) => c.berth.berthNo === form.value.berthNo)) {
      form.value.berthNo = '';
    }
  },
);

let sweeping = false;
async function runSweep(source: '启动' | '定时' | '手动'): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const count = await portStore.sweepExpiredShelters();
    if (count > 0) {
      sweepHint.value = `已自动释放 ${count} 条超时避风占用并保留记录`;
      ElMessage.warning(sweepHint.value);
    } else if (source === '手动') {
      ElMessage.success('暂无超时占用');
    }
  } finally {
    sweeping = false;
  }
}
function selectBerth(berthNo: string): void {
  form.value.berthNo = berthNo;
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value || !selectedPort.value) {
    ElMessage.warning('请选择有效的渔船与渔港');
    return;
  }
  if (willDisplace.value && selectedCandidate.value?.occupant) {
    const occupant = selectedCandidate.value.occupant;
    try {
      await ElMessageBox.confirm(
        `泊位 ${form.value.berthNo} 现由普通船「${occupant.vesselName ?? '未知船舶'}」占用（${formatDateTime(occupant.berthAt)} 靠泊）。` +
          `紧急船「${selectedVessel.value.name}」将挤走该船并为其生成改派提醒，是否继续？`,
        '紧急挤占确认',
        { type: 'warning', confirmButtonText: '挤走并紧急回港', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  submitting.value = true;
  try {
    const result = await portStore.requestEmergencyShelter(
      {
        vesselId: form.value.vesselId,
        portId: form.value.portId,
        berthNo: form.value.berthNo,
        typhoonLevel: Number(form.value.typhoonLevel),
        durationHours: Number(form.value.durationHours),
      },
      selectedVessel.value,
    );
    if (!result.ok) {
      ElMessage.warning(result.message);
      return;
    }
    ElMessage.success(result.message);
    if (result.suggestion) ElMessage.warning(`改派提醒：${result.suggestion}`);
    clearDraft();
    Object.assign(form.value, { ...emptyShelterDraft() });
  } catch (error) {
    ElMessage.error(`紧急回港失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

async function release(shelterId: string, vesselName: string): Promise<void> {
  const ok = await portStore.completeShelter(shelterId);
  if (ok) ElMessage.success(`${vesselName} 已办理离港，泊位已释放`);
}

async function handleNotice(noticeId: string): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('可填写改派去向或处理备注', '处理改派提醒', {
      confirmButtonText: '标记已处理',
      cancelButtonText: '取消',
      inputPlaceholder: '如：已改派石浦中心渔港 B05',
    });
    await portStore.handleNotice(noticeId, value ?? '');
    ElMessage.success('改派提醒已标记处理');
  } catch {
    // 用户取消
  }
}

function statusTagType(status: string): 'success' | 'warning' | 'info' {
  if (status === '有效') return 'warning';
  if (status === '已完成') return 'success';
  return 'info';
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>台风紧急回港</h1>
        <p class="page__sub">
          值班员选择避风渔港与停留时长，系统按避风等级、水深与现有占用排位安排限时占用；
          紧急船可挤掉普通船，超时自动释放并保留记录
        </p>
      </div>
      <el-button data-testid="sweep-expired" @click="runSweep('手动')">立即扫描超时占用</el-button>
    </header>

    <el-alert
      type="warning"
      show-icon
      :closable="false"
      title="紧急避险通道：证书过期渔船允许回港避风，但只能限时占用正式泊位；普通进港仍按证书拦截。"
      data-testid="shelter-banner"
    />

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">紧急回港申请</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="100px" data-testid="shelter-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select id="shelter-vessel" v-model="form.vesselId" placeholder="请选择渔船（含证书过期船）" filterable style="width: 100%">
                <el-option
                  v-for="v in vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.grossTonnage, 0)}t · 吃水需求 ${formatNumber(requiredDepthM(v))}m）`"
                  :value="v.id"
                />
              </el-select>
              <div v-if="selectedVessel" class="form-extra">
                <el-tag size="small" :type="expiryTagType()" data-testid="shelter-cert-tag">{{ expiryText() }}</el-tag>
                <el-tag v-if="vesselExpired" size="small" type="danger" effect="dark">证书过期 · 仅限紧急避风</el-tag>
                <el-tag v-else-if="ownActiveShelter" size="small" type="warning" effect="dark">
                  已在 {{ ownActiveShelter.portName }} {{ ownActiveShelter.berthNo }} 紧急避风
                </el-tag>
              </div>
            </el-form-item>

            <el-form-item label="台风等级" prop="typhoonLevel">
              <el-select v-model="form.typhoonLevel" style="width: 100%" data-testid="shelter-typhoon">
                <el-option v-for="lvl in typhoonOptions" :key="lvl" :label="`${lvl} 级`" :value="lvl" />
              </el-select>
            </el-form-item>

            <el-form-item label="避风渔港" prop="portId">
              <el-select v-model="form.portId" placeholder="请选择避风渔港" style="width: 100%" data-testid="shelter-port">
                <el-option
                  v-for="p in portStore.ports"
                  :key="p.id"
                  :label="`${p.name}（避风 ${p.shelterLevel} 级 · 水深 ${formatNumber(p.berthDepth)}m）`"
                  :value="p.id"
                  :disabled="!portCanWithstand(p, form.typhoonLevel)"
                />
              </el-select>
              <div v-if="selectedPort" class="form-extra">
                <el-tag size="small" :type="portShelterOk ? 'success' : 'danger'">
                  避风能力 {{ selectedPort.shelterLevel }} 级 · {{ portShelterOk ? '可抵御本次台风' : '不足以抵御' }}
                </el-tag>
              </div>
            </el-form-item>

            <el-form-item label="停留时长" prop="durationHours">
              <el-radio-group v-model="form.durationHours" data-testid="shelter-duration">
                <el-radio-button v-for="h in SHELTER_DURATIONS" :key="h" :value="h">
                  {{ h >= 24 ? `${h / 24} 天` : `${h} 小时` }}
                </el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="避风泊位" prop="berthNo">
              <div v-if="!selectedPort || !selectedVessel" class="berth-pick-empty">
                请先选择渔船与避风渔港，系统按避风等级、水深与现有占用给出排位
              </div>
              <div v-else class="berth-pick" data-testid="shelter-berth-candidates">
                <button
                  v-for="c in candidates"
                  :key="c.berth.id"
                  type="button"
                  class="berth-pick__item"
                  :class="{
                    'berth-pick__item--active': form.berthNo === c.berth.berthNo,
                    'berth-pick__item--displace': Boolean(c.occupant),
                  }"
                  :data-testid="`shelter-berth-${c.berth.berthNo}`"
                  @click="selectBerth(c.berth.berthNo)"
                >
                  <span class="berth-pick__no">{{ c.berth.berthNo }}</span>
                  <span class="berth-pick__meta">水深 {{ formatNumber(c.berth.designDepth) }}m</span>
                  <el-tag v-if="!c.occupant" size="small" type="success">空闲</el-tag>
                  <el-tag v-else-if="c.occupant.vesselId === selectedVessel?.id" size="small" type="info">本船普通占用</el-tag>
                  <el-tag v-else size="small" type="warning">挤占 {{ c.occupant.vesselName }}</el-tag>
                </button>
                <span v-for="b in blockedBerths" :key="b.berth.id" class="berth-pick__item berth-pick__item--blocked">
                  <span class="berth-pick__no">{{ b.berth.berthNo }}</span>
                  <span class="berth-pick__meta">{{ b.reason }}</span>
                  <el-tag size="small" type="info">不可选</el-tag>
                </span>
              </div>
            </el-form-item>

            <el-alert
              v-if="willDisplace"
              type="warning"
              show-icon
              :closable="false"
              class="displace-alert"
              :title="`将挤掉普通船「${selectedCandidate?.occupant?.vesselName ?? ''}」，提交后为其生成改派提醒`"
              data-testid="shelter-displace-alert"
            />
            <el-alert
              v-else-if="willUpgradeOwn"
              type="info"
              show-icon
              :closable="false"
              class="displace-alert"
              title="该泊位本就由本船普通占用，提交后转为台风紧急避风限时占用"
            />
            <el-alert
              v-else-if="selectedCandidate"
              type="success"
              show-icon
              :closable="false"
              class="displace-alert"
              title="该泊位空闲，紧急船可直接限时停靠"
            />

            <el-form-item>
              <el-button type="primary" :loading="submitting" data-testid="submit-shelter" @click="submit">
                确认紧急回港
              </el-button>
              <el-button data-testid="clear-shelter-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空</el-button>
            </el-form-item>
            <p class="detail-hint">表单草稿保存在 localStorage（键 {{ storageKey }}），提交成功后清空。</p>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">待处理改派提醒（{{ pendingNotices.length }}）</span>
          </template>
          <div v-if="pendingNotices.length" class="notice-list" data-testid="reroute-notices">
            <div v-for="n in pendingNotices" :key="n.id" class="notice-item">
              <div class="notice-item__head">
                <el-tag size="small" type="danger" effect="dark">已被挤走</el-tag>
                <b>{{ n.vesselName }}</b>
                <span class="notice-item__time">{{ formatDateTime(n.displacedAt) }}</span>
              </div>
              <p class="notice-item__line">
                原泊 {{ n.portName }} {{ n.berthNo }}，被紧急船「{{ n.emergencyVesselName }}」（{{ n.typhoonLevel }} 级台风）挤走
              </p>
              <p class="notice-item__line notice-item__suggest">
                {{ n.suggestionPortName ? `改派建议：${n.suggestionPortName} ${n.suggestionBerthNo ?? ''}` : '暂无满足避风等级与水深的空闲泊位，请协调邻近渔港或锚泊避风' }}
              </p>
              <el-button size="small" type="primary" plain :data-testid="`handle-notice-${n.id}`" @click="handleNotice(n.id)">
                标记已处理
              </el-button>
            </div>
          </div>
          <EmptyState v-else title="暂无待处理改派提醒" description="紧急船挤掉普通船后，会在此生成改派提醒。" />
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">在港避风排位说明</span></template>
          <ul class="rule-list">
            <li>避风能力需 ≥ 台风等级，泊位水深需 ≥ 船舶吃水 + 0.5m（本船需求 {{ formatNumber(requiredDepth) }}m）。</li>
            <li>先排水深满足的空闲泊位（浅水优先），再排可挤掉的普通占用（靠泊最早者先被挤）。</li>
            <li>紧急占用泊位与维修泊位不可选，紧急船之间互不挤占。</li>
            <li>同一艘船同时只能有一条有效紧急占用，重复提交不会多占泊位。</li>
          </ul>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header>
        <span class="card-title">生效中的限时占用（{{ activeShelters.length }} 条）</span>
      </template>
      <el-table :data="activeShelters" size="small" border empty-text="当前无生效中的紧急避风占用" data-testid="active-shelters">
        <el-table-column prop="vesselName" label="紧急船" min-width="130" />
        <el-table-column label="渔港 / 泊位" min-width="160">
          <template #default="scope">{{ scope.row.portName }} · {{ scope.row.berthNo }}</template>
        </el-table-column>
        <el-table-column label="台风 / 避风" width="110">
          <template #default="scope">{{ scope.row.typhoonLevel }} / {{ scope.row.shelterLevel }} 级</template>
        </el-table-column>
        <el-table-column label="靠泊时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.berthAt) }}</template>
        </el-table-column>
        <el-table-column label="释放时限" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.expiresAt) }}</template>
        </el-table-column>
        <el-table-column label="剩余" width="130">
          <template #default="scope">
            <el-tag size="small" type="danger" effect="plain" data-testid="shelter-countdown">
              {{ countdownText(scope.row.expiresAt) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挤占情况" min-width="150">
          <template #default="scope">
            <el-tag v-if="scope.row.displacedVesselName" size="small" type="warning">挤走 {{ scope.row.displacedVesselName }}</el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="scope">
            <el-button
              text
              type="primary"
              size="small"
              :data-testid="`release-shelter-${scope.row.id}`"
              @click="release(scope.row.id, scope.row.vesselName)"
            >
              办理离港
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">紧急回港记录（最近 {{ historyShelters.length }} 条，超时释放后保留）</span></template>
      <el-table :data="historyShelters" size="small" border empty-text="暂无历史紧急回港记录" data-testid="shelter-history">
        <el-table-column prop="vesselName" label="渔船" min-width="120" />
        <el-table-column label="渔港 / 泊位" min-width="150">
          <template #default="scope">{{ scope.row.portName }} · {{ scope.row.berthNo }}</template>
        </el-table-column>
        <el-table-column label="台风" width="80">
          <template #default="scope">{{ scope.row.typhoonLevel }} 级</template>
        </el-table-column>
        <el-table-column label="停留" width="90">
          <template #default="scope">{{ scope.row.durationHours }}h</template>
        </el-table-column>
        <el-table-column label="靠泊 / 释放" min-width="260">
          <template #default="scope">
            {{ formatDateTime(scope.row.berthAt) }} → {{ formatDateTime(scope.row.releasedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="被挤走船" min-width="130">
          <template #default="scope">{{ scope.row.displacedVesselName ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="scope">
            <el-tag size="small" :type="statusTagType(scope.row.status)">{{ scope.row.status }}</el-tag>
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
.detail-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.form-extra {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.berth-pick-empty {
  font-size: 13px;
  color: #8592a0;
  padding: 8px 0;
}
.berth-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.berth-pick__item {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 132px;
  padding: 8px 10px;
  border: 1.5px solid #c2e7b0;
  background: #f0f9eb;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.berth-pick__item--displace {
  border-color: #f0c78a;
  background: #fdf6ec;
}
.berth-pick__item--active {
  border-color: #409eff;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.18);
}
.berth-pick__item--blocked {
  border-color: #e4e7ed;
  background: #f4f4f5;
  cursor: not-allowed;
  opacity: 0.75;
}
.berth-pick__no {
  font-size: 14px;
  font-weight: 700;
  color: #17324d;
}
.berth-pick__meta {
  font-size: 11px;
  color: #6b7c8c;
}
.displace-alert {
  margin-bottom: 14px;
}
.notice-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.notice-item {
  border: 1px solid #f8d7c9;
  background: #fff8f4;
  border-radius: 8px;
  padding: 10px 12px;
}
.notice-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.notice-item__time {
  margin-left: auto;
  font-size: 12px;
  color: #9aa9b6;
}
.notice-item__line {
  margin: 6px 0;
  font-size: 13px;
  color: #4b5c6d;
}
.notice-item__suggest {
  color: #b25a1e;
}
.rule-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #4b5c6d;
}
</style>
