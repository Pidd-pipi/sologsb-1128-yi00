<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useEmergencyStore } from '../stores/emergencyStore';
import { useBerthStatus } from '../hooks/useBerthStatus';
import { formatCountdown } from '../utils/format';
import PortCard from '../components/common/PortCard.vue';
import BerthGrid from '../components/common/BerthGrid.vue';
import MapPanel from '../components/common/MapPanel.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { Berth } from '../types/berth';
import { formatDateTime, formatNumber, percentText } from '../utils/format';
import { supplyText } from '../types/port';

const route = useRoute();
const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();
const emergencyStore = useEmergencyStore();

const portId = computed(() => String(route.params.id ?? ''));
const port = computed(() => portStore.portById(portId.value));
const berthsRef = computed(() => portStore.berths);
const { summary, summaryOf, inPortVessels } = useBerthStatus(berthsRef, portId);
const portBerths = computed(() => portStore.berthsOf(portId.value));

/** 该渔港生效中的紧急限时占用 */
const portEmergencyStays = computed(() =>
  emergencyStore.activeStays.filter((s) => s.portId === portId.value),
);

function remainOf(berth: Berth): string {
  if (!berth.expireAt) return '';
  return formatCountdown(new Date(berth.expireAt).getTime() - emergencyStore.nowTick);
}

const activeBerthId = ref('');
const berthDialogVisible = ref(false);
const activeBerth = computed<Berth | null>(
  () => portStore.berths.find((b) => b.id === activeBerthId.value) ?? null,
);
const activeVessel = computed(() =>
  activeBerth.value?.vesselId ? vesselStore.vesselById(activeBerth.value.vesselId) : undefined,
);

const addBerthVisible = ref(false);
const addBerthForm = reactive({ berthNo: '', designDepth: 4.5 });

const recentCalls = computed(() => {
  // 同一泊位号在不同渔港会重复（各港均有 B01），按「该港在港 / 历史占用过的船」反查避免串港
  const vesselIds = new Set(portBerths.value.filter((b) => b.vesselId).map((b) => b.vesselId));
  return portStore.callsSorted
    .filter((c) => new Set(portBerths.value.map((b) => b.berthNo)).has(c.berthNo) && vesselIds.has(c.vesselId))
    .slice(0, 8);
});

const supply = computed(() => (port.value ? supplyText(port.value.supply) : '—'));

const loaded = ref(false);

async function bootstrap(): Promise<void> {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!emergencyStore.stays.length) await emergencyStore.loadAll();
  loaded.value = true;
}

onMounted(bootstrap);
watch(portId, bootstrap);

function openBerth(berth: Berth): void {
  activeBerthId.value = berth.id;
  berthDialogVisible.value = true;
}

async function markMaintenance(): Promise<void> {
  const berth = activeBerth.value;
  if (!berth) return;
  await portStore.setBerthStatus(berth.id, '维修');
  ElMessage.success(`${berth.berthNo} 已置为维修`);
}

async function releaseBerth(): Promise<void> {
  const berth = activeBerth.value;
  if (!berth) return;
  await portStore.setBerthStatus(berth.id, '空闲');
  ElMessage.success(`${berth.berthNo} 已释放为空闲`);
}

async function releaseEmergency(stayId: string): Promise<void> {
  const stay = emergencyStore.stayById(stayId);
  if (!stay) return;
  try {
    await ElMessageBox.confirm(`确认 ${stay.vesselName} 提前结束紧急避险并释放 ${stay.berthNo}？`, '释放紧急占用', {
      type: 'warning',
      confirmButtonText: '释放',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await emergencyStore.releaseStay(stayId, '手动释放');
  berthDialogVisible.value = false;
  ElMessage.success(`${stay.vesselName} 已驶离，${stay.berthNo} 已释放`);
}

async function submitBerth(): Promise<void> {
  const no = addBerthForm.berthNo.trim();
  if (!no) {
    ElMessage.warning('请填写泊位号，如 B09');
    return;
  }
  const created = await portStore.addBerth(portId.value, no, addBerthForm.designDepth);
  if (!created) {
    ElMessage.warning('该泊位号已存在');
    return;
  }
  addBerthVisible.value = false;
  addBerthForm.berthNo = '';
  ElMessage.success(`已新增泊位 ${created.berthNo}`);
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}

function onMapSelect(selectedPortId: string): void {
  if (selectedPortId === portId.value) {
    ElMessage.info('当前即为该渔港');
    return;
  }
  void router.push(`/ports/${selectedPortId}`);
}
</script>

<template>
  <section class="page">
    <el-breadcrumb separator="/">
      <el-breadcrumb-item :to="{ path: '/' }">渔港一览</el-breadcrumb-item>
      <el-breadcrumb-item>{{ port ? port.name : '渔港详情' }}</el-breadcrumb-item>
    </el-breadcrumb>

    <template v-if="port">
      <header class="page__head">
        <div>
          <h1>{{ port.name }}</h1>
          <p class="page__sub">{{ port.level }} · 管理单位：{{ port.manager }}</p>
        </div>
        <div class="page__head-actions">
          <el-button data-testid="open-berth-dialog" @click="addBerthVisible = true">新增泊位</el-button>
          <el-button type="danger" plain @click="router.push('/emergency')">台风紧急回港</el-button>
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </div>
      </header>

      <el-row :gutter="16">
        <el-col :lg="10" :md="24">
          <PortCard :port="port" :summary="summaryOf(port.id)" :clickable="false" />
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">基本信息与补给能力</span></template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="经纬度">
                {{ formatNumber(port.longitude, 4) }}°E / {{ formatNumber(port.latitude, 4) }}°N
              </el-descriptions-item>
              <el-descriptions-item label="泊位数">{{ port.berthCount }} 个</el-descriptions-item>
              <el-descriptions-item label="泊位水深">{{ formatNumber(port.berthDepth) }} m</el-descriptions-item>
              <el-descriptions-item label="码头长度">{{ formatNumber(port.wharfLength, 0) }} m</el-descriptions-item>
              <el-descriptions-item label="避风能力">{{ port.shelterLevel }} 级</el-descriptions-item>
              <el-descriptions-item label="补给能力">{{ supply }}</el-descriptions-item>
            </el-descriptions>
            <p class="detail-hint">
              当前占用率 {{ percentText(summary.occupancyRate) }}（占用 {{ summary.occupied }} / 空闲 {{ summary.free }} / 维修 {{ summary.maintenance }}）
              <el-tag v-if="summary.emergency" size="small" type="danger" effect="plain">紧急限时 {{ summary.emergency }}</el-tag>
            </p>
          </el-card>
        </el-col>

        <el-col :lg="14" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">渔港分布（地图 / 网格）</span></template>
            <MapPanel
              :ports="portStore.ports"
              :berths="portStore.berths"
              :focused-port-id="port.id"
              :height="300"
              @select-port="onMapSelect"
            />
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">泊位网格（点击泊位查看占用船舶）</span>
        </template>
        <BerthGrid
          v-if="portBerths.length"
          :berths="portBerths"
          :now-tick="emergencyStore.nowTick"
          @select="openBerth"
        />
        <EmptyState v-else title="该渔港暂无泊位记录" description="点击右上角「新增泊位」为该渔港建立泊位清单。">
          <el-button type="primary" @click="addBerthVisible = true">新增泊位</el-button>
        </EmptyState>
      </el-card>

      <el-card v-if="portEmergencyStays.length" shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">台风紧急限时占用（{{ portEmergencyStays.length }} 条）</span>
        </template>
        <el-table :data="portEmergencyStays" size="small" border data-testid="port-emergency-table">
          <el-table-column prop="vesselName" label="紧急回港船" min-width="120" />
          <el-table-column prop="berthNo" label="泊位号" width="80" />
          <el-table-column label="台风等级" width="90">
            <template #default="scope">{{ scope.row.typhoonLevel }} 级</template>
          </el-table-column>
          <el-table-column label="到期时间" min-width="150">
            <template #default="scope">{{ formatDateTime(scope.row.expireAt) }}</template>
          </el-table-column>
          <el-table-column label="倒计时" width="140">
            <template #default="scope">
              <el-tag size="small" type="danger">{{ formatCountdown(new Date(scope.row.expireAt).getTime() - emergencyStore.nowTick) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="被挤走普通船" min-width="120">
            <template #default="scope">{{ scope.row.displacedVesselName ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="scope">
              <el-button text type="primary" size="small" @click="releaseEmergency(scope.row.id)">提前释放</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-row :gutter="16">
        <el-col :lg="12" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">在港船舶（{{ inPortVessels.length }} 艘）</span></template>
            <el-table :data="inPortVessels" size="small" border empty-text="当前无在港船舶">
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column prop="berthNo" label="泊位号" width="80" />
              <el-table-column label="性质" width="90">
                <template #default="scope">
                  <el-tag size="small" :type="scope.row.occupyKind === '紧急' ? 'danger' : 'warning'">
                    {{ scope.row.occupyKind === '紧急' ? '紧急限时' : '普通' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="靠泊 / 到期" min-width="200">
                <template #default="scope">
                  <div>{{ formatDateTime(scope.row.berthAt) }}</div>
                  <div v-if="scope.row.occupyKind === '紧急'" class="emergency-expire">
                    <el-tag size="small" type="danger">{{ remainOf(scope.row) }}</el-tag>
                    <span class="expire-text">{{ formatDateTime(scope.row.expireAt) }} 自动释放</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="scope">
                  <el-button
                    text
                    type="primary"
                    size="small"
                    :disabled="!scope.row.vesselId"
                    @click="openVessel(scope.row.vesselId)"
                  >
                    档案
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>

        <el-col :lg="12" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">近日流水</span></template>
            <el-table :data="recentCalls" size="small" border empty-text="暂无进出港流水">
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column prop="type" label="类型" width="80" />
              <el-table-column label="时间" min-width="150">
                <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
              </el-table-column>
              <el-table-column prop="berthNo" label="泊位号" width="90" />
              <el-table-column label="卸货 kg" min-width="100">
                <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>
    </template>

    <EmptyState
      v-else-if="loaded"
      title="未找到该渔港"
      description="该渔港可能尚未登记，返回一览页登记后再查看。"
    >
      <el-button type="primary" @click="router.push('/')">返回渔港一览</el-button>
    </EmptyState>

    <el-dialog v-model="berthDialogVisible" title="泊位占用详情" width="520px" data-testid="berth-dialog">
      <template v-if="activeBerth">
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="泊位号">{{ activeBerth.berthNo }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag
              size="small"
              :type="
                activeBerth.occupyKind === '紧急'
                  ? 'danger'
                  : activeBerth.status === '占用'
                    ? 'warning'
                    : activeBerth.status === '维修'
                      ? 'info'
                      : 'success'
              "
            >
              {{ activeBerth.occupyKind === '紧急' ? '紧急限时占用' : activeBerth.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="设计水深">{{ formatNumber(activeBerth.designDepth) }} m</el-descriptions-item>
          <el-descriptions-item label="占用渔船">
            <template v-if="activeBerth.vesselName">
              <el-link type="primary" data-testid="berth-vessel-link" @click="activeBerth.vesselId && openVessel(activeBerth.vesselId)">
                {{ activeBerth.vesselName }}
              </el-link>
            </template>
            <template v-else>—</template>
          </el-descriptions-item>
          <el-descriptions-item label="靠泊时间">{{ formatDateTime(activeBerth.berthAt) }}</el-descriptions-item>
          <el-descriptions-item v-if="activeBerth.occupyKind === '紧急'" label="到期时间">
            <el-tag size="small" type="danger">{{ remainOf(activeBerth) }}</el-tag>
            <span style="margin-left: 8px">{{ formatDateTime(activeBerth.expireAt) }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-else label="离泊时间">{{ formatDateTime(activeBerth.leaveAt) }}</el-descriptions-item>
          <el-descriptions-item label="主机功率">
            {{ activeVessel ? `${formatNumber(activeVessel.enginePower, 0)} kW` : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="总吨位">
            {{ activeVessel ? `${formatNumber(activeVessel.grossTonnage)} t` : '—' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="berthDialogVisible = false">关闭</el-button>
        <el-button
          v-if="activeBerth?.occupyKind === '紧急' && activeBerth.status === '占用'"
          type="danger"
          data-testid="berth-release-emergency"
          @click="activeBerth.emergencyStayId && releaseEmergency(activeBerth.emergencyStayId)"
        >
          紧急占用提前释放
        </el-button>
        <el-button
          v-else
          type="warning"
          data-testid="berth-maintenance"
          :disabled="!activeBerth || (activeBerth.status !== '空闲' && activeBerth.status !== '占用')"
          @click="markMaintenance"
        >
          置为维修
        </el-button>
        <el-button
          v-if="activeBerth && activeBerth.occupyKind !== '紧急'"
          type="success"
          data-testid="berth-release"
          :disabled="activeBerth.status !== '占用'"
          @click="releaseBerth"
        >
          释放为空闲
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="addBerthVisible" title="新增泊位" width="420px">
      <el-form label-width="90px">
        <el-form-item label="泊位号">
          <el-input id="berth-no" v-model="addBerthForm.berthNo" placeholder="如：B09" />
        </el-form-item>
        <el-form-item label="设计水深 m">
          <el-input-number id="berth-depth" v-model="addBerthForm.designDepth" :min="1" :max="30" :step="0.1" :precision="1" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addBerthVisible = false">取消</el-button>
        <el-button type="primary" data-testid="submit-berth" @click="submitBerth">保存泊位</el-button>
      </template>
    </el-dialog>
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
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.emergency-expire {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.expire-text {
  font-size: 12px;
  color: #c45656;
}
</style>
