<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useVesselStore } from '../stores/vesselStore';
import { usePortStore } from '../stores/portStore';
import VesselSpecTable from '../components/common/VesselSpecTable.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { PortCall } from '../types/call';
import type { EmergencyShelter, RerouteNotice } from '../types/shelter';
import { daysUntilExpiry, expiryText, powerTier, tonnageTier } from '../utils/tonnage';
import { formatDateTime, formatNumber } from '../utils/format';
import { useNow } from '../hooks/useNow';

const route = useRoute();
const router = useRouter();
const vesselStore = useVesselStore();
const portStore = usePortStore();
const { nowMs, remainingMinutesOf } = useNow();

const vesselId = computed(() => String(route.params.id ?? ''));
const vessel = computed(() => vesselStore.vesselById(vesselId.value));
const loaded = ref(false);

const calls = computed<PortCall[]>(() => (vessel.value ? portStore.callsOfVessel(vessel.value.id) : []));

/** 该船当前的泊位占用（普通或紧急），渔港详情 / 地图 / 档案读同一份临时占用数据 */
const occupancy = computed(() => {
  if (!vessel.value) return [] as Array<{
    portName: string;
    berthNo: string;
    berthAt: string | null;
    emergency: boolean;
    expiresAt: string | null;
    typhoonLevel: number | null;
  }>;
  return portStore.berths
    .filter((b) => b.vesselId === vessel.value!.id && b.status === '占用')
    .map((b) => ({
      portName: portStore.portById(b.portId)?.name ?? b.portId,
      berthNo: b.berthNo,
      berthAt: b.berthAt,
      emergency: b.occupancyKind === '紧急',
      expiresAt: b.expiresAt ?? null,
      typhoonLevel: b.typhoonLevel ?? null,
    }));
});

/** 该船生效中的紧急避风占用 */
const activeShelter = computed<EmergencyShelter | undefined>(() =>
  vessel.value ? portStore.activeShelterOfVessel(vessel.value.id) : undefined,
);

/** 该船紧急回港历史（含超时释放记录） */
const shelterHistory = computed<EmergencyShelter[]>(() =>
  vessel.value ? portStore.sheltersOfVessel(vessel.value.id) : [],
);

/** 该船被挤走的改派提醒 */
const rerouteNotices = computed<RerouteNotice[]>(() =>
  vessel.value ? portStore.noticesOfVessel(vessel.value.id) : [],
);

const expiryDays = computed(() => (vessel.value ? daysUntilExpiry(vessel.value.certificateExpiry) : Number.NaN));

const expiryTagType = computed(() => {
  const days = expiryDays.value;
  if (Number.isNaN(days)) return 'info';
  if (days < 0) return 'danger';
  if (days <= 90) return 'warning';
  return 'success';
});

const totals = computed(() => ({
  ice: calls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: calls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: calls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function timelineType(call: PortCall): 'primary' | 'success' {
  return call.type === '进港' ? 'primary' : 'success';
}

function countdownText(expiresAt: string | null): string {
  const mins = remainingMinutesOf(expiresAt);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

async function releaseShelter(): Promise<void> {
  if (!activeShelter.value) return;
  const ok = await portStore.completeShelter(activeShelter.value.id);
  if (ok) ElMessage.success(`${activeShelter.value.vesselName} 已办理离港，泊位已释放`);
}

async function handleNotice(noticeId: string): Promise<void> {
  await portStore.handleNotice(noticeId, '档案页确认已知悉改派');
  ElMessage.success('改派提醒已标记处理');
}

async function bootstrap(): Promise<void> {
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!portStore.calls.length) await portStore.loadAll();
  await portStore.sweepExpiredShelters();
  loaded.value = true;
}

onMounted(bootstrap);
watch(vesselId, bootstrap);
watch(nowMs, () => {
  void portStore.sweepExpiredShelters();
});
</script>

<template>
  <section class="page">
    <el-breadcrumb separator="/">
      <el-breadcrumb-item :to="{ path: '/vessels' }">渔船检索</el-breadcrumb-item>
      <el-breadcrumb-item>{{ vessel ? vessel.name : '渔船档案' }}</el-breadcrumb-item>
    </el-breadcrumb>

    <template v-if="vessel">
      <header class="page__head">
        <div>
          <h1>{{ vessel.name }}</h1>
          <p class="page__sub">
            渔船编号 {{ vessel.vesselNo }} · 船籍港 {{ vessel.homePort }} · 船主 {{ vessel.owner }}
          </p>
        </div>
        <div class="page__head-actions">
          <el-tag effect="dark">{{ vessel.operationType }}</el-tag>
          <el-tag type="info" effect="plain">{{ vessel.hullMaterial }}</el-tag>
          <el-button type="danger" plain @click="router.push('/shelter')">台风紧急回港</el-button>
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </div>
      </header>

      <el-row :gutter="16">
        <el-col :lg="16" :md="24">
          <VesselSpecTable :vessels="[vessel]" :clickable="false" />
        </el-col>
        <el-col :lg="8" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">档案要点</span></template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="总吨位">
                {{ formatNumber(vessel.grossTonnage) }} t（{{ tonnageTier(vessel.grossTonnage) }}）
              </el-descriptions-item>
              <el-descriptions-item label="主机功率">
                {{ formatNumber(vessel.enginePower, 0) }} kW（{{ powerTier(vessel.enginePower) }}）
              </el-descriptions-item>
              <el-descriptions-item label="证书有效期">
                {{ vessel.certificateExpiry }}
                <el-tag size="small" :type="expiryTagType" data-testid="expiry-tag">{{ expiryText(vessel.certificateExpiry) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="累计进出港">{{ calls.length }} 次</el-descriptions-item>
              <el-descriptions-item label="累计加冰 / 加油">
                {{ formatNumber(totals.ice, 0) }} kg / {{ formatNumber(totals.fuel, 0) }} L
              </el-descriptions-item>
              <el-descriptions-item label="累计卸货">{{ formatNumber(totals.unload, 0) }} kg</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card shadow="never" class="detail-card">
            <template #header>
              <span class="card-title">当前泊位</span>
              <el-tag v-if="activeShelter" size="small" type="danger" effect="dark" class="head-tag">紧急避风中</el-tag>
            </template>
            <el-table :data="occupancy" size="small" border empty-text="该船当前不在港" data-testid="vessel-current-berth">
              <el-table-column prop="portName" label="渔港" min-width="120" />
              <el-table-column prop="berthNo" label="泊位号" width="80" />
              <el-table-column label="类型" width="90">
                <template #default="scope">
                  <el-tag v-if="scope.row.emergency" size="small" type="danger" effect="dark">紧急</el-tag>
                  <el-tag v-else size="small" type="warning" effect="plain">普通</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="靠泊 / 释放时限" min-width="200">
                <template #default="scope">
                  {{ formatDateTime(scope.row.berthAt) }}
                  <div v-if="scope.row.emergency" class="emergency-line">
                    限至 {{ formatDateTime(scope.row.expiresAt) }}
                    <el-tag size="small" type="danger" effect="plain">剩 {{ countdownText(scope.row.expiresAt) }}</el-tag>
                  </div>
                </template>
              </el-table-column>
            </el-table>
            <div v-if="activeShelter" class="shelter-action">
              <el-alert
                type="warning"
                show-icon
                :closable="false"
                :title="`台风 ${activeShelter.typhoonLevel} 级紧急避风 · ${activeShelter.portName} ${activeShelter.berthNo} · 剩余 ${countdownText(activeShelter.expiresAt)}`"
              />
              <el-button
                type="primary"
                size="small"
                class="shelter-action__btn"
                data-testid="vessel-release-shelter"
                @click="releaseShelter"
              >
                办理离港
              </el-button>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">台风紧急避风记录（{{ shelterHistory.length }} 条）</span>
        </template>
        <el-table
          v-if="shelterHistory.length"
          :data="shelterHistory"
          size="small"
          border
          data-testid="vessel-shelter-history"
        >
          <el-table-column label="渔港 / 泊位" min-width="170">
            <template #default="scope">{{ scope.row.portName }} · {{ scope.row.berthNo }}</template>
          </el-table-column>
          <el-table-column label="台风" width="80">
            <template #default="scope">{{ scope.row.typhoonLevel }} 级</template>
          </el-table-column>
          <el-table-column label="停留" width="80">
            <template #default="scope">{{ scope.row.durationHours }}h</template>
          </el-table-column>
          <el-table-column label="靠泊 → 释放" min-width="260">
            <template #default="scope">
              {{ formatDateTime(scope.row.berthAt) }} → {{ formatDateTime(scope.row.releasedAt ?? scope.row.expiresAt) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="scope">
              <el-tag
                size="small"
                :type="scope.row.status === '有效' ? 'danger' : scope.row.status === '已完成' ? 'success' : 'info'"
              >
                {{ scope.row.status }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <EmptyState v-else title="暂无台风紧急避风记录" description="台风期间证书过期也可在「台风紧急回港」页申请限时避风。" />
      </el-card>

      <el-card v-if="rerouteNotices.length" shadow="never" class="detail-card">
        <template #header><span class="card-title">改派提醒（被紧急船挤走记录）</span></template>
        <div class="notice-list" data-testid="vessel-reroute-notices">
          <div v-for="n in rerouteNotices" :key="n.id" class="notice-item" :class="{ 'notice-item--done': n.handled }">
            <div class="notice-item__head">
              <el-tag size="small" :type="n.handled ? 'info' : 'danger'" effect="plain">
                {{ n.handled ? '已处理' : '待处理' }}
              </el-tag>
              <span>{{ formatDateTime(n.displacedAt) }} 于 {{ n.portName }} {{ n.berthNo }} 被紧急船「{{ n.emergencyVesselName }}」（{{ n.typhoonLevel }} 级台风）挤走</span>
            </div>
            <p class="notice-item__line">
              {{ n.suggestionPortName ? `改派建议：${n.suggestionPortName} ${n.suggestionBerthNo ?? ''}` : '当时无满足避风等级与水深的空闲泊位' }}
              <span v-if="n.handleNote"> · 处理备注：{{ n.handleNote }}</span>
            </p>
            <el-button v-if="!n.handled" size="small" type="primary" plain @click="handleNotice(n.id)">标记已处理</el-button>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <template #header><span class="card-title">进出港记录时间线（{{ calls.length }} 条）</span></template>
        <el-timeline v-if="calls.length" data-testid="call-timeline">
          <el-timeline-item
            v-for="call in calls"
            :key="call.id"
            :timestamp="formatDateTime(call.time)"
            :type="timelineType(call)"
            placement="top"
          >
            <div class="timeline-row">
              <el-tag size="small" :type="call.type === '进港' ? 'primary' : 'success'">{{ call.type }}</el-tag>
              <span>泊位 {{ call.berthNo }}</span>
              <span>加冰 {{ formatNumber(call.iceKg, 0) }} kg</span>
              <span>加油 {{ formatNumber(call.fuelL, 0) }} L</span>
              <span>卸货 {{ formatNumber(call.unloadKg, 0) }} kg</span>
              <el-tag size="small" type="info" effect="plain">{{ call.visaStatus }}</el-tag>
            </div>
          </el-timeline-item>
        </el-timeline>
        <EmptyState v-else title="暂无进出港记录" description="该渔船尚未登记进出港流水，可前往登记页补录。">
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </EmptyState>
      </el-card>
    </template>

    <EmptyState v-else-if="loaded" title="未找到该渔船" description="该渔船档案可能尚未建立，返回检索页建档后再查看。">
      <el-button type="primary" @click="router.push('/vessels')">返回渔船检索</el-button>
    </EmptyState>
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
.page__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.timeline-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.head-tag {
  margin-left: 8px;
}
.emergency-line {
  font-size: 12px;
  color: #c45656;
}
.shelter-action {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.shelter-action__btn {
  flex-shrink: 0;
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
.notice-item--done {
  border-color: #e4e7ed;
  background: #fafafa;
}
.notice-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #4b5c6d;
}
.notice-item__line {
  margin: 6px 0;
  font-size: 13px;
  color: #b25a1e;
}
</style>
