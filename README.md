# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、渔船技术档案与进出港动态集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率与吨位的渔船档案、记录进出港与泊位占用；
台风压境时提供**紧急回港限时占用**通道：证书过期船也可进港避风，按避风等级、水深与现有占用排位，
紧急船可挤掉普通船并生成改派提醒，超时自动释放泊位并保留记录。

## 一键启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21828>

停止：

```bash
docker compose down
```

## 技术栈

| 分类 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 |
| UI | Element Plus 2 |
| 状态 | Pinia |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbfishport-db`）+ localStorage（表单草稿） |
| 地图 | 高德地图 JS API（`VITE_AMAP_KEY`），未配置 key 时降级为本地 SVG 网格视图 |
| 托管 | nginx:alpine（gzip + 前端路由回退） |

## 目录结构

```
sologsb-1128/
├── docker-compose.yml          # 无 version 字段；顶层 name: gbfishport
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / shelter.ts（5 个数据模型）
│       ├── stores/             # portStore.ts（含紧急占用与超时扫描）/ vesselStore.ts / uiStore.ts
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / seed.ts
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / EmptyState
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft / useNow
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / EmergencyShelter / MapView
│       ├── router/index.ts
│       └── utils/              # tonnage.ts / geo.ts / format.ts
└── README.md
```

## 页面与路由

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数与占用率，支持按等级与避风能力筛选 | FishingPort、Berth、PortCall |
| `/ports/:id` | 渔港详情：基本信息与补给能力、SVG 泊位网格（点击查看占用船舶）、在港船舶与近日流水 | 四个模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期与进出港时间线 | FishingVessel、PortCall |
| `/calls` | 进出港登记：选择渔船与类型，填写泊位号、加冰量、加油量、卸货量并同步泊位状态；普通进港按证书拦截 | PortCall、Berth、FishingVessel |
| `/shelter` | 台风紧急回港：值班员选渔港与停留时长，按避风等级、水深与现有占用排位，紧急船可挤掉普通船；处理改派提醒、查看生效中占用与历史记录 | EmergencyShelter、RerouteNotice、Berth、FishingPort、FishingVessel |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位占用摘要（含紧急占用） | FishingPort、Berth |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：新增 `shelters`（台风紧急避风占用）与 `rerouteNotices`（改派提醒）两张表
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`、紧急回港草稿 `gbfishport:draft:emergency-shelter`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条进出港流水与对应泊位，外加 1 条生效中的紧急避风占用、1 条改派提醒与 1 条超时历史记录），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

## 台风紧急回港规则（限时占用）

- **证书放行边界**：普通进港（`/calls`）仍按证书拦截，证书过期渔船的进港申请会被拒绝；台风紧急回港（`/shelter`）允许证书过期船进港避险，但只能限时占用正式泊位。
- **避风等级与水深**：渔港 `shelterLevel` 必须 ≥ 申报台风等级；泊位设计水深必须 ≥ 船舶吃水（按总吨位估算）+ 0.5m 富余水深。
- **候选排位**：先排水深满足的空闲泊位（浅水优先，留深水给大船），再排可挤掉的普通占用（靠泊时间最早者优先被挤）；维修泊位与紧急占用泊位不可选，紧急船之间互不挤占。
- **两条唯一性**：同一泊位同一时段只保留一条有效占用（紧急占用写入 `berths` 并带 `emergencyId`）；同一艘船同时只能有一条有效紧急占用，重复提交不会多占。
- **挤船与改派**：挤掉普通船时为其生成改派提醒，按「能扛住本次台风 + 水深满足 + 有空闲泊位」推荐邻近渔港泊位，值班员可在紧急回港页或渔船档案页标记已处理。
- **超时释放**：应用每 30 秒扫描一次（紧急回港页也可手动扫描），超过 `expiresAt` 的占用自动置为「已超时」、释放泊位，记录永久保留在 `shelters` 表；也可提前办理离港（状态「已完成」）。
- **一处写入、三处一致**：紧急占用直接写入泊位模型，渔港详情、地图摘要与渔船档案读取的是同一份临时占用数据。

## 高德地图 Key（可选）

`VITE_AMAP_KEY` 留空时**不会**请求任何外部地图服务，`useAmapLoader()` 立即返回降级标记，页面渲染本地 SVG 网格视图（可点选查看泊位占用）。需要真实底图时，在 `.env` 中填入 key 后重新构建：

```bash
VITE_AMAP_KEY=your-key docker compose up -d --build
```

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev
```

构建校验（类型检查 + 打包）：`npm run build`（等价于 `vue-tsc -b && vite build`）。

紧急回港领域规则与挤占/超时流程的 Node 冒烟脚本（需先 `npm install`）：

```bash
node scripts/smoke-shelter.mjs   # 水深估算 / 证书 / 避风等级 / 排位 / 改派建议
node scripts/smoke-store.mjs     # 挤占普通船 / 重复提交拦截 / 超时释放（fake-indexeddb）
```
