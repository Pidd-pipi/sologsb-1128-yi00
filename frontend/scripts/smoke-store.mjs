// 紧急回港 store 集成冒烟：挤占普通船、重复提交拦截、同泊位唯一、超时释放
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));

const result = await build({
  entryPoints: ['scripts/_store-entry.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  define: { 'import.meta.env.VITE_AMAP_KEY': '""' },
});
writeFileSync('/dev/shm/store.mjs', result.outputFiles[0].text);
const mod = await import('file:///dev/shm/store.mjs');
const { run } = mod;

let passed = 0;
function check(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS: ${name}`);
}

await run({ check, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
console.log(`\n集成用例全部通过（${passed} 项）`);
