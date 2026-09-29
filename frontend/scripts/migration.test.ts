/**
 * Dexie v3 → v4 升级冒烟：构造一个仅含旧结构（berths 无 occupyKind）的库，
 * 重新打开后确认迁移补齐占用性质字段，且新表可写。
 * 用法：npm run test:migration
 */
import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import type { Berth } from '../src/types/berth';

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
  const DB_NAME = 'gbfishport-migration-test';

  // 1) 用旧版本号 3 建库，写一条不含新字段的泊位
  {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    const legacy = new Dexie(DB_NAME) as Dexie & {
      berths: import('dexie').Table<Berth, string>;
    };
    legacy.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });
    legacy.version(2).stores({ calls: 'id, vesselId, type, time' });
    legacy.version(3).stores({ berths: 'id, portId, berthNo, status, vesselId' });
    await legacy.table('berths').add({
      id: 'old-B01',
      portId: 'p-old',
      berthNo: 'B01',
      vesselId: 'v-old',
      vesselName: '旧船',
      berthAt: new Date().toISOString(),
      leaveAt: null,
      status: '占用',
      designDepth: 4.5,
    });
    await legacy.table('ports').put({ id: 'p-old', name: '旧港' } as never);
    legacy.close();
  }

  // 2) 以 v4 定义重新打开，触发 upgrade（与 src/db/index.ts 的 v4 保持一致）
  const migrated = new Dexie(DB_NAME) as Dexie & { berths: import('dexie').Table<Berth, string> };
  migrated
    .version(4)
    .stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
      calls: 'id, vesselId, type, time',
      berths: 'id, portId, berthNo, status, vesselId, [portId+vesselId], emergencyStayId',
      emergencyStays: 'id, vesselId, portId, berthId, status, expireAt, displacedVesselId',
      reassignNotices: 'id, stayId, vesselId, portId, read',
    })
    .upgrade(async (tx) => {
      await tx
        .table<Berth, string>('berths')
        .toCollection()
        .modify((berth) => {
          if (!berth.occupyKind) berth.occupyKind = '普通';
          if (berth.expireAt === undefined) berth.expireAt = null;
          if (berth.emergencyStayId === undefined) berth.emergencyStayId = null;
        });
    });
  await migrated.open();

  console.log('v3 → v4 迁移');
  assert(migrated.verno >= 4, `库版本升到 ≥4（实际 ${migrated.verno}）`);
  const berth = await migrated.berths.get('old-B01');
  assert(berth?.occupyKind === '普通', '旧占用泊位回填 occupyKind=普通');
  assert(berth?.expireAt === null && berth.emergencyStayId === null, '旧泊位紧急字段补 null');
  assert(migrated.tables.some((t) => t.name === 'emergencyStays'), 'emergencyStays 表已建');
  assert(migrated.tables.some((t) => t.name === 'reassignNotices'), 'reassignNotices 表已建');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
  migrated.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
