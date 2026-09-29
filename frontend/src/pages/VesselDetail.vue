<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useVesselStore } from '../stores/vesselStore';
import { usePortStore } from '../stores/portStore';
import { useEmergencyStore } from '../stores/emergencyStore';
import VesselSpecTable from '../components/common/VesselSpecTable.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { PortCall } from '../types/call';
import { daysUntilExpiry, expiryText, powerTier, tonnageTier } from '../utils/tonnage';
import { formatCountdown, formatDateTime, formatNumber } from '../utils/format';

const route = useRoute();
const router = useRouter();
const vesselStore = useVesselStore();
const portStore = usePortStore();
const emergencyStore = useEmergencyStore();

const vesselId = computed(() => String(route.params.id ?? ''));
const vessel = computed(() => vesselStore.vesselById(vesselId.value));
const loaded = ref(false);

const calls = computed<PortCall[]>(() => (vessel.value ? portStore.callsOfVessel(vessel.value.id) : []));

const occupancy = computed(() => {
  if (!vessel.value) return [] as Array<{ portName: string; berthNo: string; berthAt: string | null; kind: string; expireAt: string | null }>;
  return portStore.berths
    .filter((b) => b.vesselId === vessel.value!.id && b.status === '占用')
    .map((b) => ({
      portName: portStore.portById(b.portId)?.name ?? b.portId,
      berthNo: b.berthNo,
      berthAt: b.berthAt,
      kind: b.occupyKind === '紧急' ? '紧急限时' : '普通',
      expireAt: b.expireAt ?? null,
    }));
});

/** 本船被紧急船挤走后收到的改派提醒 */
const reassignmentNotices = computed(() =>
  vessel.value ? emergencyStore.notices.filter((n) => n.vesselId === vessel.value!.id) : [],
);

/** 本船的紧急回港历史 */
const emergencyHistory = computed(() =>
  vessel.value
    ? emergencyStore.historyStays.filter((s) => s.vesselId === vessel.value!.id)
    : [],
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

async function bootstrap(): Promise<void> {
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!portStore.calls.length) await portStore.loadAll();
  if (!emergencyStore.stays.length) await emergencyStore.loadAll();
  loaded.value = true;
}

onMounted(bootstrap);
watch(vesselId, bootstrap);
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
          <el-button type="danger" plain @click="router.push('/emergency')">台风紧急回港</el-button>
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
            <template #header><span class="card-title">当前泊位</span></template>
            <el-table :data="occupancy" size="small" border empty-text="该船当前不在港">
              <el-table-column prop="portName" label="渔港" min-width="120" />
              <el-table-column prop="berthNo" label="泊位号" width="80" />
              <el-table-column label="性质" width="90">
                <template #default="scope">
                  <el-tag size="small" :type="scope.row.kind === '紧急限时' ? 'danger' : 'warning'">
                    {{ scope.row.kind }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="靠泊时间" min-width="140">
                <template #default="scope">{{ formatDateTime(scope.row.berthAt) }}</template>
              </el-table-column>
              <el-table-column label="到期 / 倒计时" min-width="170">
                <template #default="scope">
                  <template v-if="scope.row.kind === '紧急限时' && scope.row.expireAt">
                    <el-tag size="small" type="danger">
                      {{ formatCountdown(new Date(scope.row.expireAt).getTime() - emergencyStore.nowTick) }}
                    </el-tag>
                    <div class="expire-line">{{ formatDateTime(scope.row.expireAt) }} 自动释放</div>
                  </template>
                  <span v-else>长期占用（普通进港）</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">改派提醒（{{ reassignmentNotices.length }}）</span></template>
            <el-timeline v-if="reassignmentNotices.length" data-testid="vessel-notices">
              <el-timeline-item
                v-for="n in reassignmentNotices"
                :key="n.id"
                :timestamp="formatDateTime(n.displacedAt)"
                :type="n.read ? 'info' : 'danger'"
                placement="top"
              >
                <div class="notice-line">
                  <el-tag size="small" :type="n.read ? 'info' : 'danger'">{{ n.read ? '已阅' : '待改派' }}</el-tag>
                  <span>{{ n.suggestion }}</span>
                  <el-button v-if="!n.read" text type="primary" size="small" @click="emergencyStore.markNoticeRead(n.id)">
                    阅知
                  </el-button>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="该船没有被紧急船挤走的记录" :image-size="60" />
          </el-card>
        </el-col>
      </el-row>

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

      <el-card v-if="emergencyHistory.length" shadow="never" class="detail-card">
        <template #header><span class="card-title">台风紧急回港记录（{{ emergencyHistory.length }} 条）</span></template>
        <el-table :data="emergencyHistory" size="small" border data-testid="vessel-emergency-history">
          <el-table-column prop="portName" label="避风渔港" min-width="120" />
          <el-table-column prop="berthNo" label="泊位号" width="80" />
          <el-table-column label="台风等级" width="90">
            <template #default="scope">{{ scope.row.typhoonLevel }} 级</template>
          </el-table-column>
          <el-table-column label="靠泊时间" min-width="140">
            <template #default="scope">{{ formatDateTime(scope.row.startAt) }}</template>
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
          <el-table-column label="申报时证书" width="100">
            <template #default="scope">
              <el-tag size="small" :type="scope.row.certificateExpired ? 'danger' : 'success'">
                {{ scope.row.certificateExpired ? '已过期' : '有效' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
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
.notice-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.expire-line {
  margin-top: 2px;
  font-size: 12px;
  color: #c45656;
}
</style>
