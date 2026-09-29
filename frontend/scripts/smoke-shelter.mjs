// 紧急回港领域规则冒烟测试：用 esbuild 即时转译 TS 后在 node 中执行
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/utils/shelter.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
});
writeFileSync('/dev/shm/shelter.mjs', result.outputFiles[0].text);
const mod = await import('file:///dev/shm/shelter.mjs');
const {
  estimateDraftM,
  requiredDepthM,
  isCertificateExpired,
  portCanWithstand,
  rankBerthCandidates,
  findFreeBerth,
  suggestReroutePort,
} = mod;

let passed = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS: ${name}`);
}

// 吃水估算：56t -> 2.2m + 0.5 = 2.7m
check('小型船 56t 需求水深 2.7m', requiredDepthM({ grossTonnage: 56 }) === 2.7);
// 88t: 2.2 + (28/90) = 2.511 -> +0.5 = 3.0
check('中型船 88t 需求水深约 3.0m', requiredDepthM({ grossTonnage: 88 }) === 3.0);
// 196t: 3.2 + (46/150) = 3.507 -> +0.5 = 4.0
check('大型船 196t 需求水深约 4.0m', requiredDepthM({ grossTonnage: 196 }) === 4.0);

// 证书过期
const future = { certificateExpiry: '2030-01-01' };
const past = { certificateExpiry: '2020-01-01' };
check('未来证书未过期', isCertificateExpired(future, new Date('2026-09-29T00:00:00')) === false);
check('过去证书已过期', isCertificateExpired(past, new Date('2026-09-29T00:00:00')) === true);

// 避风等级
check('避风能力 11 级可扛 11 级台风', portCanWithstand({ shelterLevel: 11 }, 11) === true);
check('避风能力 9 级扛不住 11 级台风', portCanWithstand({ shelterLevel: 9 }, 11) === false);

// 候选排位：浅水空闲优先；紧急/维修/浅水不足不可选；普通占用按靠泊时间排
const now = Date.now();
const iso = (h) => new Date(now + h * 3600 * 1000).toISOString();
const berths = [
  { id: 'b1', portId: 'p1', berthNo: 'B01', status: '维修', designDepth: 6 },
  { id: 'b2', portId: 'p1', berthNo: 'B02', status: '占用', designDepth: 5, occupancyKind: '紧急', vesselName: '紧急船', berthAt: iso(0) },
  { id: 'b3', portId: 'p1', berthNo: 'B03', status: '空闲', designDepth: 6 },
  { id: 'b4', portId: 'p1', berthNo: 'B04', status: '空闲', designDepth: 4 },
  { id: 'b5', portId: 'p1', berthNo: 'B05', status: '空闲', designDepth: 2.5 },
  { id: 'b6', portId: 'p1', berthNo: 'B06', status: '占用', designDepth: 6, occupancyKind: '普通', vesselName: '晚到普通船', berthAt: iso(-1) },
  { id: 'b7', portId: 'p1', berthNo: 'B07', status: '占用', designDepth: 5.5, occupancyKind: '普通', vesselName: '早到普通船', berthAt: iso(-5) },
];
// 需要 3.0m
const ranked = rankBerthCandidates(berths, 3.0).map((c) => c.berth.berthNo);
check('排位顺序为 浅水空闲 B04 -> 深水空闲 B03 -> 早到普通 B07 -> 晚到普通 B06', JSON.stringify(ranked) === JSON.stringify(['B04', 'B03', 'B07', 'B06']));
check('浅水不足的 B05 被排除', !ranked.includes('B05'));
check('维修 B01 与紧急 B02 不可挤占', !ranked.includes('B01') && !ranked.includes('B02'));

// 改派建议：能扛台风 + 水深 + 空闲泊位；排除原港
const ports = [
  { id: 'p1', name: 'A港', shelterLevel: 9 },
  { id: 'p2', name: 'B港', shelterLevel: 12 },
  { id: 'p3', name: 'C港', shelterLevel: 11 },
];
const all = [
  { portId: 'p1', berthNo: 'X1', status: '空闲', designDepth: 6 },
  { portId: 'p2', berthNo: 'Y1', status: '占用', designDepth: 6 },
  { portId: 'p3', berthNo: 'Z1', status: '空闲', designDepth: 6 },
];
const byPort = (pid) => all.filter((b) => b.portId === pid);
const sug = suggestReroutePort(ports, byPort, 3.0, 11, 'p1');
check('改派建议跳过扛不住的 A港 与无空位的 B港，选中 C港', sug && sug.port.id === 'p3' && sug.berth.berthNo === 'Z1');

// findFreeBerth 水深门槛
check('水深 2.5m 的空闲泊位不满足 3.0m 需求', findFreeBerth([{ status: '空闲', designDepth: 2.5 }], 3.0) === null);

console.log(`\n全部 ${passed} 项通过`);
