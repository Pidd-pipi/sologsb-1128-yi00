/**
 * 紧急回港核心规则的内存端到端校验（fake-indexeddb + 真实 Pinia store）。
 * 用法：npm run test:emergency
 * 覆盖：空闲直占 / LIFO 挤普通船 / 紧急不互挤 / 同船去重（库级）/
 *       证书过期普通进港拦截 / 普通重复进港拦截 / 超时释放 / 手动释放 / 排位与避风等级。
 */
import 'fake-indexeddb/auto';
import { setActivePinia, createPinia } from 'pinia';
import { usePortStore } from '../src/stores/portStore';
import { useVesselStore } from '../src/stores/vesselStore';
import { useEmergencyStore } from '../src/stores/emergencyStore';
import { db } from '../src/db';
import { SEED_PORTS, SEED_VESSELS } from '../src/db/seed';
import { buildBerthRecords } from '../src/db/berth';
import { pickEmergencyBerth, rankPortsForEmergency, estimateDraft } from '../src/utils/emergency';
import type { CallDraft } from '../src/types/call';

let passed = 0;
let failed = 0;

function assert(cond: boolean, message: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function expectThrow(fn: () => Promise<unknown>, fragment: string, label: string): Promise<void> {
  let message = '';
  try {
    await fn();
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes(fragment), `${label}（抛出含「${fragment}」的错误，实际：${message || '未抛错'}）`);
}

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await db.ports.bulkAdd(structuredClone(SEED_PORTS));
  await db.vessels.bulkAdd(structuredClone(SEED_VESSELS));
  for (const port of SEED_PORTS) {
    await db.berths.bulkAdd(structuredClone(buildBerthRecords(port)));
  }
}

function callDraft(over: Partial<CallDraft> = {}): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: new Date().toISOString(),
    berthNo: '',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
    ...over,
  };
}

async function main(): Promise<void> {
  setActivePinia(createPinia());
  const portStore = usePortStore();
  const vesselStore = useVesselStore();
  const emergencyStore = useEmergencyStore();

  await resetDb();
  await vesselStore.loadAll();
  await portStore.loadAll();
  await emergencyStore.loadAll();

  const p1001 = 'p-1001';
  const p1004 = 'p-1004';
  const expiredAtSea2 = 'v-2007'; // 浙象渔05999，证书过期，种子中在 p-1001 B05 普通占用
  const expiredAtSea = 'v-2008'; // 浙象渔05777，证书过期，在海上（未占泊位）
  const freeValid = 'v-2004'; // 浙岭渔09342，证书有效，在海上
  const v2009 = 'v-2009'; // 浙奉渔08118，证书有效，演示数据中在 p-1001 B06（最晚靠泊的普通船）
  const v2001 = 'v-2001';
  const draft = Math.round(estimateDraft(vesselStore.vesselById(expiredAtSea2)!) * 10) / 10;
  const draft2 = Math.round(estimateDraft(vesselStore.vesselById(expiredAtSea)!) * 10) / 10;

  console.log('1. 普通进港证书拦截');
  await expectThrow(
    () =>
      portStore.registerCall(
        callDraft({ vesselId: expiredAtSea, type: '进港', berthNo: 'B01' }),
        '浙象渔05777',
        p1004,
      ),
    '证书',
    '证书过期船普通进港被拦截',
  );

  console.log('2. 普通重复进港拦截（同船已在港，即使选别的港的空闲泊位）');
  // v-2001 证书有效且在 p-1001 B01 占用，去 p-1004 的空闲泊位也应被拦
  await expectThrow(
    () =>
      portStore.registerCall(
        callDraft({ vesselId: v2001, type: '进港', berthNo: 'B01' }),
        '浙象渔05123',
        p1004,
      ),
    '不能重复进港',
    '同一艘船重复进港被拦截',
  );

  console.log('3. 紧急回港：有空闲泊位时直接占用，不挤船');
  // p-1004（温岭石塘）初始 4 个全空闲，避风 9 级
  {
    const result = await emergencyStore.applyEmergency({
      vesselId: expiredAtSea,
      portId: p1004,
      typhoonLevel: 9,
      durationHours: 12,
      vesselDraft: draft2,
    });
    assert(result.displaced === null, '空闲泊位直占，无船被挤');
    const berth = await db.berths.get(result.stay.berthId);
    assert(berth?.berthNo === 'B01', '排位：同水深按泊位号取最靠前的空闲泊位 B01');
    assert(berth?.status === '占用' && berth.occupyKind === '紧急', '泊位记为紧急限时占用');
    assert(berth?.vesselId === expiredAtSea, '泊位上是过期证书的紧急船');
    assert((berth?.expireAt ?? '').length > 0, '泊位写入到期时间');
  }

  console.log('4. 同一艘船重复紧急申报不能多占');
  await expectThrow(
    () =>
      emergencyStore.applyEmergency({
        vesselId: expiredAtSea,
        portId: p1001,
        typhoonLevel: 12,
        durationHours: 6,
        vesselDraft: draft2,
      }),
    '已有一条生效中的紧急占用',
    '同船重复紧急申报被拦截',
  );

  console.log('5. 手动释放后泊位归还、记录保留');
  {
    const stay = emergencyStore.activeStayOfVessel(expiredAtSea)!;
    await emergencyStore.releaseStay(stay.id, '手动释放');
    const berth = await db.berths.get(stay.berthId);
    assert(berth?.status === '空闲' && berth.vesselId === null, '释放后泊位清空');
    const history = emergencyStore.historyStays.find((s) => s.id === stay.id);
    assert(history?.status === '已释放' && history.releaseReason === '手动释放', '释放记录保留为「手动释放」');
  }

  console.log('6. 避风等级不足的渔港拒绝接纳');
  await expectThrow(
    () =>
      emergencyStore.applyEmergency({
        vesselId: expiredAtSea,
        portId: p1004, // 避风 9 级
        typhoonLevel: 12,
        durationHours: 6,
        vesselDraft: draft2,
      }),
    '不足以抵御',
    '9 级渔港拒绝 12 级台风申报',
  );

  console.log('7. 无空闲时 LIFO 挤掉现有占用排位最末的普通船');
  {
    // 此时 p-1001：B01(v-2001)/B02(v-2005)/B03(v-2004)/B05(expiredAtSea2 v-2007)/B06(v-2009) 普通占用，B04 维修
    // expiredAtSea(v-2008) 在 #5 已释放、当前无占用，直接申请 p-1001 → 应挤掉最晚靠泊的 v-2009
    const result = await emergencyStore.applyEmergency({
      vesselId: expiredAtSea,
      portId: p1001,
      typhoonLevel: 12,
      durationHours: 6,
      vesselDraft: draft2, // 3.6m，全部泊位水深 5.5m 适配
    });
    assert(result.displaced?.vesselId === v2009, '挤掉的是最晚靠泊的普通船 浙奉渔08118（B06）');
    const berth = await db.berths.get('p-1001-B06');
    assert(berth?.vesselId === expiredAtSea && berth.occupyKind === '紧急', 'B06 改由紧急船限时占用');
    // 其他普通船原封不动
    const b01 = await db.berths.get('p-1001-B01');
    assert(b01?.vesselId === v2001 && b01.status === '占用', '排位靠前的普通船 B01 不受影响');
    const b05 = await db.berths.get('p-1001-B05');
    assert(b05?.vesselId === expiredAtSea2 && b05.status === '占用', 'B05 的普通船 浙象渔05999 不受影响');
    const notice = await db.reassignNotices.where('vesselId').equals(v2009).first();
    assert(Boolean(notice) && !notice!.read && notice.berthNo === 'B06', '为被挤船留下未读改派提醒');
  }

  console.log('8. 紧急限时占用之间不可互相挤用');
  {
    const berths = await db.berths.where('portId').equals(p1001).toArray();
    // 极端场景：所有非维修泊位都被紧急占用
    const allEmergency = berths
      .filter((b) => b.status !== '维修')
      .map((b) => ({ ...b, status: '占用' as const, occupyKind: '紧急' as const, vesselId: 'vx', vesselName: '其他紧急船' }));
    const pick = pickEmergencyBerth(SEED_PORTS[0], allEmergency, draft, 12);
    assert(pick === null, '满港紧急船时不互挤（无可挤目标）');
  }

  console.log('9. 同一泊位同一时段库级唯一性（并发重复提交）');
  {
    // #7 后：B06 为紧急（expiredAtSea v-2008）、B05 v-2007 普通占用；手动释放 B06 紧急占用
    const b06stay = emergencyStore.stays.find(
      (s) => s.berthId === 'p-1001-B06' && s.status === '生效中',
    );
    if (b06stay) await emergencyStore.releaseStay(b06stay.id, '手动释放');
    // 此时 B01/B02 分别由 v-2001/v-2005 普通占用，B02 上两船（v-2001 已在 B01、v-2004 在 B03）并发都会被拦
    // 先释放 B01/B03，让 v-2001、v-2004 都「在港但可换泊」不行（它们仍在 B05/B03）……
    // 唯一性要测的是同一泊位：直接让 v-2005 先离港释放 B02，再让它与另一艘空闲船并发抢 B02
    await portStore.registerCall(callDraft({ vesselId: 'v-2005', type: '出港', berthNo: 'B02' }), '浙象渔05288', p1001);
    await portStore.setBerthStatus('p-1001-B05', '空闲');
    await portStore.setBerthStatus('p-1001-B03', '空闲');
    const attempts = await Promise.allSettled([
      portStore.registerCall(callDraft({ vesselId: 'v-2007', berthNo: 'B02' }), '浙象渔05999', p1001),
      portStore.registerCall(callDraft({ vesselId: 'v-2004', berthNo: 'B02' }), '浙岭渔09342', p1001),
    ]);
    const rejects = attempts.filter((a) => a.status === 'rejected');
    assert(rejects.length === 1, '并发抢同一泊位时恰好一条被拒');
    const winner = await db.berths.get('p-1001-B02');
    assert(winner?.status === '占用' && (winner.vesselId === v2001 || winner.vesselId === 'v-2004'), 'B02 胜出者写入');
  }

  console.log('10. 超时自动释放并保留记录');
  {
    // #9 中 expiredAtSea 在 p-1004 B01 有生效中的紧急占用，先释放，再新建一条即将超时的
    const existing = emergencyStore.activeStayOfVessel(expiredAtSea);
    if (existing) await emergencyStore.releaseStay(existing.id, '手动释放');
    const start = await emergencyStore.applyEmergency({
      vesselId: expiredAtSea,
      portId: p1004,
      typhoonLevel: 9,
      durationHours: 1,
      vesselDraft: draft2,
    });
    // 手动把到期时间改到过去
    const stale: typeof start.stay = {
      ...start.stay,
      startAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      expireAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    };
    await db.emergencyStays.put(stale);
    await db.berths.update(stale.berthId, {
      berthAt: stale.startAt,
      expireAt: stale.expireAt,
    });
    await emergencyStore.loadAll();
    const released = await emergencyStore.sweepExpired();
    assert(released.length === 1 && released[0].releaseReason === '超时释放', '扫描到 1 条到期占用并标记超时释放');
    const berth = await db.berths.get(stale.berthId);
    assert(berth?.status === '空闲', '超时后泊位释放');
    const row = await db.emergencyStays.get(stale.id);
    assert(row?.status === '已释放' && row.releaseReason === '超时释放', '超时记录保留');
  }

  console.log('11. 渔港排位：能接纳的优先于扛不住风的');
  {
    const ranks = rankPortsForEmergency(SEED_PORTS, await db.berths.toArray(), draft, 12);
    assert(ranks.every((r) => r.port.shelterLevel >= 12), '排位结果只含避风达标渔港');
    assert(ranks[0]?.port.shelterLevel === Math.max(...ranks.map((r) => r.port.shelterLevel)), '避风最强者排首位');
  }

  console.log('12. 普通出港释放链路仍正常');
  {
    // #9 竞态后 B02 由 v-2001 / v-2004 之一普通占用，按胜出者办出港
    const b02 = await db.berths.get('p-1001-B02');
    assert(b02?.status === '占用' && b02.occupyKind !== '紧急' && b02.vesselId, 'B02 为普通占用');
    const winnerName = b02.vesselName as string;
    await portStore.registerCall(
      callDraft({ vesselId: b02.vesselId as string, type: '出港', berthNo: 'B02' }),
      winnerName,
      p1001,
    );
    const berth = await db.berths.get('p-1001-B02');
    assert(berth?.status === '空闲', '普通出港后泊位释放');
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
