import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { db } from '../src/db';
import { usePortStore } from '../src/stores/portStore';
import type { FishingPort } from '../src/types/port';
import type { FishingVessel } from '../src/types/vessel';

interface Check {
  (name: string, cond: boolean): void;
}

export async function run({ check }: { check: Check; sleep: (ms: number) => Promise<void> }): Promise<void> {
  // 每个测试库独立
  indexedDB.deleteDatabase('gbfishport-db');
  const pinia = createPinia();
  setActivePinia(pinia);

  const portsSeed: FishingPort[] = [
    {
      id: 'p1', name: '甲渔港', level: '中心渔港', longitude: 121, latitude: 29,
      berthCount: 2, berthDepth: 6, wharfLength: 300, shelterLevel: 12,
      supply: { fuel: true, ice: true, water: true }, manager: '站', createdAt: new Date().toISOString(),
    },
    {
      id: 'p2', name: '乙渔港', level: '二级渔港', longitude: 122, latitude: 30,
      berthCount: 1, berthDepth: 4, wharfLength: 100, shelterLevel: 9,
      supply: { fuel: false, ice: false, water: true }, manager: '站', createdAt: new Date().toISOString(),
    },
  ];
  const vesselsSeed: FishingVessel[] = [
    {
      id: 'v1', name: '普通船甲', vesselNo: 'AA000001', homePort: '甲', length: 20, beam: 5,
      grossTonnage: 56, enginePower: 96, operationType: '钓具', hullMaterial: '木质',
      owner: '船东', certificateExpiry: '2030-01-01', createdAt: new Date().toISOString(),
    },
    {
      id: 'v2', name: '过期船乙', vesselNo: 'AA000002', homePort: '乙', length: 24, beam: 5,
      grossTonnage: 88, enginePower: 158, operationType: '刺网', hullMaterial: '钢质',
      owner: '船东', certificateExpiry: '2020-01-01', createdAt: new Date().toISOString(),
    },
  ];
  await db.ports.bulkPut(portsSeed);
  await db.vessels.bulkPut(vesselsSeed);
  await db.berths.bulkPut([
    {
      id: 'p1-B01', portId: 'p1', berthNo: 'B01', vesselId: 'v1', vesselName: '普通船甲',
      berthAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(), leaveAt: null,
      status: '占用', designDepth: 6, occupancyKind: '普通', emergencyId: null, expiresAt: null, typhoonLevel: null,
    },
    {
      id: 'p1-B02', portId: 'p1', berthNo: 'B02', vesselId: null, vesselName: null,
      berthAt: null, leaveAt: null, status: '空闲', designDepth: 5,
    },
    {
      id: 'p2-B01', portId: 'p2', berthNo: 'B01', vesselId: null, vesselName: null,
      berthAt: null, leaveAt: null, status: '空闲', designDepth: 4,
    },
  ]);

  const store = usePortStore();
  await store.loadAll();

  // 1) 普通进港：证书过期被拦截
  let threw = false;
  try {
    await store.registerCall(
      { vesselId: 'v2', type: '进港', time: '', berthNo: 'B02', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '待签证' },
      '过期船乙',
      'p1',
    );
  } catch {
    threw = true;
  }
  check('普通进港对证书过期渔船抛错拦截', threw);

  // 2) 避风等级不足拒绝
  const lowShelter = await store.requestEmergencyShelter(
    { vesselId: 'v2', portId: 'p2', berthNo: 'B01', typhoonLevel: 12, durationHours: 24 },
    vesselsSeed[1],
  );
  check('避风能力不足时 ok=false', lowShelter.ok === false);

  // 3) 水深不足拒绝（88t 需 3.0m；人为要求深水：换一个浅泊位通过 berthDepth 已 4m，满足。改为用 B01 占用场景测水深 -> 直接校验返回 message）
  // p2 水深 4m 满足 3.0m，台风 9 级可以，但我们先测同船重复占用
  const ok1 = await store.requestEmergencyShelter(
    { vesselId: 'v2', portId: 'p1', berthNo: 'B01', typhoonLevel: 11, durationHours: 24 },
    vesselsSeed[1],
  );
  check('过期船紧急回港挤掉普通船成功', ok1.ok === true && ok1.displaced === true);
  check('改派建议非空（p1 同港 B02 空闲时不会出现，因为排除原港；无其他合适港时给出锚泊文案）', typeof ok1.suggestion === 'string');

  // 泊位状态
  const b01 = store.berths.find((b) => b.id === 'p1-B01');
  check('B01 变为紧急占用且船为过期船乙', b01.status === '占用' && b01.occupancyKind === '紧急' && b01.vesselId === 'v2');
  check('B01 上有紧急记录 id 与到期时间', Boolean(b01.emergencyId) && Boolean(b01.expiresAt));

  // 改派提醒生成
  check('被挤走的普通船甲生成一条待处理改派提醒', store.pendingNotices.length === 1 && store.pendingNotices[0].vesselId === 'v1');

  // 4) 同一艘船重复提交不能多占
  const dup = await store.requestEmergencyShelter(
    { vesselId: 'v2', portId: 'p1', berthNo: 'B02', typhoonLevel: 11, durationHours: 12 },
    vesselsSeed[1],
  );
  check('同一艘船第二条有效紧急占用被拒绝', dup.ok === false);
  check('重复提交未占用 B02', store.berths.find((b) => b.id === 'p1-B02').status === '空闲');

  // 5) 同一泊位不能有第二条有效紧急占用（另一艘船也不行）
  const sameBerth = await store.requestEmergencyShelter(
    { vesselId: 'v1', portId: 'p1', berthNo: 'B01', typhoonLevel: 11, durationHours: 12 },
    vesselsSeed[0],
  );
  check('紧急占用泊位拒绝第二条紧急占用', sameBerth.ok === false);

  // 6) 空闲泊位可直接紧急停靠（普通船甲，证书有效，被挤走后现在无泊位）
  const direct = await store.requestEmergencyShelter(
    { vesselId: 'v1', portId: 'p1', berthNo: 'B02', typhoonLevel: 11, durationHours: 1 },
    vesselsSeed[0],
  );
  check('普通船甲在空闲泊位紧急停靠成功', direct.ok === true && direct.displaced === false);

  // 7) 办理离港：释放 B02，状态已完成
  const shelter1 = direct.shelter;
  const released = await store.completeShelter(shelter1.id);
  check('办理离港返回 true', released === true);
  check('离港后 B02 释放为空闲', store.berths.find((b) => b.id === 'p1-B02').status === '空闲');
  check('记录保留为已完成', store.shelterById(shelter1.id)?.status === '已完成');

  // 8) 超时扫描：把过期船乙的占用改为已过期（同步 store 内存状态与库），再扫描
  const active = store.shelters.find((s) => s.vesselId === 'v2' && s.status === '有效');
  const pastIso = new Date(Date.now() - 1000).toISOString();
  await db.shelters.update(active.id, { expiresAt: pastIso });
  store.shelters = store.shelters.map((s) => (s.id === active.id ? { ...s, expiresAt: pastIso } : s));
  const count = await store.sweepExpiredShelters();
  check('超时扫描释放 1 条', count === 1);
  check('超时后 B01 释放为空闲', store.berths.find((b) => b.id === 'p1-B01').status === '空闲');
  check('超时记录保留为已超时', store.shelterById(active.id)?.status === '已超时');

  // 9) 释放后同船可再次申请
  const again = await store.requestEmergencyShelter(
    { vesselId: 'v2', portId: 'p1', berthNo: 'B01', typhoonLevel: 11, durationHours: 6 },
    vesselsSeed[1],
  );
  check('超时释放后同船可再次紧急回港', again.ok === true);

  // 10) 持久化：重新 loadAll 数据一致
  const pinia2 = createPinia();
  setActivePinia(pinia2);
  const reloaded = usePortStore();
  await reloaded.loadAll();
  check('重载后紧急占用记录仍在（共 3 条：1 有效 + 已完成 + 已超时）', reloaded.shelters.length === 3);
  check('重载后 B01 仍为紧急占用', reloaded.berths.find((b) => b.id === 'p1-B01').occupancyKind === '紧急');
}
