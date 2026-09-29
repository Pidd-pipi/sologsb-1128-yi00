# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、渔船技术档案与进出港动态集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率与吨位的渔船档案、记录进出港与泊位占用；台风压境时为证书过期船只提供**限时紧急回港**通道。

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
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / emergency.ts（5 个数据模型）
│       ├── stores/             # portStore.ts / vesselStore.ts / uiStore.ts / emergencyStore.ts
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / seed.ts
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / EmptyState
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft / useEmergencyWatchdog
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / EmergencyBoard / MapView
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
| `/calls` | 进出港登记：选择渔船与类型，填写泊位号、加冰量、加油量、卸货量并同步泊位状态；证书过期船只普通进港被拦截并给出紧急通道入口 | PortCall、Berth、FishingVessel |
| `/emergency` | 台风紧急回港：值班员选定避风渔港与停留时长，按避风等级、水深与现有占用排位分配限时泊位，必要时挤掉排位最末普通船并发送改派提醒；支持手动释放、倒计时与到期自动释放 | EmergencyStay、ReassignmentNotice、Berth、FishingVessel |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位占用摘要 | FishingPort、Berth |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：新增 `emergencyStays`（台风紧急限时占用，释放后记录保留）与 `reassignNotices`（被挤普通船的改派提醒）表；`berths` 补 `occupyKind / expireAt / emergencyStayId` 字段，并新增 `[portId+vesselId]` 复合索引
- **台风紧急回港（限时占用）规则**（见 `/emergency`）：
  - 证书过期船只的**普通进港一律拦截**，提示改走紧急通道；紧急通道豁免证书校验（申报时留痕证书状态）
  - 值班员选定渔港、台风等级、估算吃水与停留时长（≤72h）；渔港避风等级 < 台风等级时不予接纳，泊位水深 < 吃水不参与排位
  - 排位优先用空闲泊位（水深最贴近吃水者优先，保留深水泊位）；港内无空闲时挤掉**现有占用排位最末（最晚靠泊）的普通船**，紧急限时占用之间不可互挤
  - 抢占过程在单个 Dexie 事务内复检，保证：同一泊位同一时段只有一条有效占用；同一艘船重复提交不能多占（无论普通还是紧急）
  - 被挤走的普通船立刻收到「改派提醒」，在紧急通道、渔船档案与地图摘要中可阅知
  - 看门狗（1s 倒计时 + 20s 扫描）到期自动释放泊位并将占用记录标记为「超时释放」；值班员也可提前手动释放，记录全程保留
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`、紧急回港草稿 `gbfishport:draft:emergency-board`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条进出港流水与对应泊位），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

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
