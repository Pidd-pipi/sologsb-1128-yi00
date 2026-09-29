/**
 * 首次播种冒烟：模拟新用户首次打开（空库 → ensureSeedData），
 * 校验预置的台风紧急占用与 berths 表状态、改派提醒三处一致。
 * 用法：npm run test:seed
 */
import 'fake-indexeddb/auto';
import { setActivePinia, createPinia } from 'pinia';
import { db } from '../src/db';
import { ensureSeedData } from '../src/db/seed';

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

async function main(): Promise<void> {
  setActivePinia(createPinia());
  await db.delete();
  await db.open();

  await ensureSeedData();
  // 幂等：再跑一次不应产生重复数据
  await ensureSeedData();

  console.log('首次播种一致性');
  assert((await db.ports.count()) === 4, '4 座渔港');
  assert((await db.vessels.count()) === 9, '9 艘渔船（含 2 艘新增）');
  assert((await db.emergencyStays.count()) === 1, '1 条预置紧急占用（幂等）');
  assert((await db.reassignNotices.count()) === 1, '1 条预置改派提醒（幂等）');

  const stay = await db.emergencyStays.get('e-seed-4001');
  assert(stay?.status === '生效中' && stay.certificateExpired === true, '预置占用生效中且申报时证书已过期');
  assert(stay?.displacedVesselId === 'v-2009', '记录挤走的普通船 v-2009');

  const berth = await db.berths.get('p-1001-B06');
  assert(berth?.status === '占用' && berth.occupyKind === '紧急', 'B06 为紧急限时占用');
  assert(berth?.vesselId === 'v-2008', 'B06 上是紧急船 浙象渔05777');
  assert(berth?.expireAt === stay?.expireAt && berth.emergencyStayId === stay?.id, '泊位到期时间/关联 id 与占用记录一致');

  const notice = await db.reassignNotices.get('n-seed-5001');
  assert(Boolean(notice) && notice!.vesselId === 'v-2009' && !notice!.read, '改派提醒指向被挤的 浙奉渔08118 且未读');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
