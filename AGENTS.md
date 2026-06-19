# EvoBot — 项目状态

> 最后更新：2026-06-19  
> **当前版本**: v7 (`src-ts-v7/`) — AI 驱动，极简架构  
> **已归档**: v6 (`archive/v6/`) — 分层架构参考  
> **并存**: v5 (`v5/`) — JavaScript 生产版

---

## 目录

1. [项目概述](#1-项目概述)
2. [环境与现实约束](#2-环境与现实约束)
3. [v6 架构](#3-v6-架构)
4. [能力路线图（6层）](#4-能力路线图6层)
5. [关键设计决策](#5-关键设计决策)
6. [启动方式](#6-启动方式)
7. [开发命令](#7-开发命令)

---

## 1. 项目概述

构建一个基于 `mineflayer` 的 Minecraft 自主 AI Agent。目标是"接近人类玩家的稳定行为"，而非短暂演示型智能。

**当前主线**：工程稳定性和可恢复性 — 机器人必须能在不稳定服务器下持续完成小任务、断线后恢复、累积长期收益。

**演进路线**：
```
v5 JS → 全功能 bot，单文件架构（bot.js）
v6 TS → 分层架构，先做稳定性，再做智能化
```

---

## 2. 环境与现实约束

### 服务器状态
- 服务器 `127.0.0.1:25565`，离线模式，1.20.1
- **服务器会在约 8 秒主动断开连接**（ECONNRESET）
- 断开高概率是服务器端风控/反bot/兼容策略（v5/v6 同症）
- **任务必须在短连接窗口内完成，长路径/大任务不可行**

### 核心约束
1. 不假设持续在线 — 按"间歇在线 agent"设计
2. 不假设 position 永远可信 — PositionHealth 状态机
3. 不假设 pathfinder 能稳定跑完长路径 — 短步任务
4. 不假设 LLM 能做实时控制 — 仅用于高层规划+复盘+spec

---

## 3. v6 架构

```
src-ts/
├── index.ts                # 启动入口 (配置加载+控制台命令)
├── core/bot.ts             # 核心入口 (bot初始化+层串联+重连)
├── types/index.ts          # 完整类型系统 (含 Goal/StepSequence)
├── executor/               # 任务执行器
│   ├── executor.ts         #   优先级队列任务执行器
│   └── step-executor.ts    #   短步执行器 (5s原子步+断线续传)
├── skills/                 # 确定性底层技能
│   ├── base.ts             #   BaseSkill 抽象类 (timeout/retry/cancel)
│   ├── movement.ts         #   MoveToSkill (NaN guard, pathfinding)
│   ├── collect.ts          #   CollectSkill (block scan, dig stance)
│   ├── collect-steps.ts    #   Step-based collect (原子步, 断线续传)
│   ├── pickup.ts           #   PickupSkill (dropped item scan+collect)
│   ├── combat.ts           #   RetreatSkill + attackNearestHostile
│   ├── eat.ts              #   EatSkill (手动进食)
│   └── dig/
│       └── dig-stance-planner.ts  # 站位规划器
├── layers/                 # 功能层
│   ├── orchestrator.ts     #   统一调度层 (submitIntent/intents队列/锁管理)
│   ├── action-controller.ts#   身体控制权锁 (谁在控制body)
│   ├── arbiter.ts          #   安全仲裁 (veto/approve intent)
│   ├── goal-manager.ts     #   目标管理 (生命周期/优先级排序)
│   ├── commander.ts        #   AI Commander (LLM决策下一步)
│   ├── behavior.ts         #   行为引擎 (闲逛/采集/自动吃/社交/pickup)
│   ├── safety.ts           #   安全层 (敌对规避/卡死恢复/饥饿)
│   ├── position-health.ts  #   位置状态机 (trusted/degraded/invalid)
│   ├── checkpoint.ts       #   检查点管理 (save/load/resume, step支持)
│   ├── memory.ts           #   记忆层 (失败/成功记录/查询)
│   ├── perception.ts       #   世界感知 (实体/方块/时间扫描)
│   ├── planner.ts          #   LLM规划器 (目标→计划生成+复盘)
│   ├── gap-detector.ts     #   技能缺口检测器 (6级规则分类)
│   ├── spec-generator.ts   #   Spec生成器 (GapFinding→SkillSpec)
│   └── dashboard-state.ts  #   仪表板状态聚合器 (含goal/control)
├── web/dashboard.ts        # 仪表板 HTTP+WS 服务器 (含goal/control面板)
└── utils/
    ├── nan-guard.ts        # isFiniteVec3, NaNTracer (20条环形缓冲)
    └── llm.ts              # 共享 LLM 客户端
```

### 层间数据流

```
Commander (LLM, 规则) → GoalManager → Orchestrator → Executor → Skills
                              ↑              ↑
                        Behavior → submitTask/Intent
                        Safety → raiseEmergency → forceAcquire
                        PositionHealth → onInvalid → interruptAllRunning
                              ↓
                        Memory ← Checkpoint ← GapDetector → SpecGenerator
                              ↓
                        Dashboard (HTTP:3000)
```

**控制原则**：
- 普通任务：`submitIntent()` → Orchestrator 统一排队
- 紧急刹车：Safety/PH 直接停 body（pathfinder.stop/clearControlStates）
- 安全通知：停完后通过 `raiseEmergency` / `onInvalid` 通知 Orchestrator
- 锁机制：ActionController 保证同一时刻只有一个控制源

---

## 4. 能力路线图（6层）

### Level 1 — 自己活着（生存层）
> 目标是：bot 在任何情况下优先保证自己存活

| 能力 | 状态 | 实现 |
|------|------|------|
| 吃饭 | ✅ | `mineflayer-auto-eat` + `EatSkill` + Behavior `auto_eat` |
| 避险 | ✅ | Safety 层：敌对规避、伤害响应 |
| 逃跑 | ✅ | `RetreatSkill`（远离危险）+ `attackNearestHostile` |
| 夜晚不乱死 | ✅ | Perception 日夜检测 + Behavior 避夜（pending refined） |
| 断线能恢复 | ✅ | 指数退避重连 + Checkpoint save/load/resume |
| 避水 | ✅ | Wander 目标过滤 + 水中逃生 `findSafeLanding` |

### Level 2 — 自己做基础事（技能层）
> bot 能独立完成基础生存和资源获取

| 能力 | 状态 | 实现 |
|------|------|------|
| 采木 | ✅ | `CollectSkill` + `collect-steps`（断线续采） |
| 采石 | ✅ | `CollectSkill`（任何方块） |
| 采煤 | ✅ | `CollectSkill` + Perception 扫描 |
| 采铁 | 🔄 | 同上，需铁镐前置（Level 2 前置条件） |
| 合成工具 | ❌ | 需要 CraftSkill（未实现） |
| 整理背包 | ❌ | 需要 InventoryManager（未实现） |
| 自动拾取 | ✅ | `PickupSkill` + Behavior `pickup` |

### Level 3 — 自己持续完成目标（目标层）
> 设定目标后能自主分解、执行、累积进度

| 能力 | 状态 | 实现 |
|------|------|------|
| 设定目标 | ✅ | `plan <goal>` + LLM Planner |
| 目标生命周期 | ✅ | GoalManager：add/set/pause/complete/fail |
| 目标优先级排序 | ✅ | GoalManager `selectNext()`：survival > user > autonomous |
| 目标分解为任务 | ✅ | Planner `planAndExecute` |
| 失败后重试/改路 | ✅ | Executor retry + Arbiter 冷却 |
| 长时间累积进度 | ✅ | Checkpoint（每5s + 断线自动保存） |
| 断线续跑目标 | ✅ | Checkpoint resume + step-checkpoint |
| 没目标时自动兜底 | ✅ | GoalManager `generateIdleGoal()` → wander/gather |

### Level 4 — 自己处理异常（韧性层）
> 遇到异常时能降级恢复，不卡死

| 能力 | 状态 | 实现 |
|------|------|------|
| 卡住能恢复 | ✅ | Safety unstuck：180s 不动 → clear + 重试 |
| 目标丢了能重找 | ✅ | Behavior/pickup 找不到目标 → 冷却后重扫 |
| 断线能续跑 | ✅ | Checkpoint + step-executor 断线续传 |
| NaN 能降级和恢复 | ✅ | PositionHealth 状态机：invalid→degraded(3s)→trusted |
| 身体控制权不打架 | ✅ | ActionController + Orchestrator 统一调度 |
| Safety 抢锁后通知 | ✅ | Safety `raiseEmergency` → Orchestrator |
| 紧急停止链路完整 | ✅ | 每个直接 stop 都有事件回调 |
| 服务端换 IP | ✅ | `server <host> <port>` 运行时切换 |

### Level 5 — 自己发现能力缺口（诊断层）
> 知道自己哪里老失败，区分原因，生成改进方案

| 能力 | 状态 | 实现 |
|------|------|------|
| 聚类失败模式 | ✅ | GapDetector：按 actionKey + failureType 聚类 |
| 区分参数问题 | ✅ | `no_gap_param_issue`：timeout 多但偶尔成功 |
| 区分 precondition | ✅ | `no_gap_precondition`：秒拒 + not_possible |
| 区分 planner 问题 | ✅ | `no_gap_planner_issue`：source=planner + 高耗时失败 |
| 识别真 skill gap | ✅ | `skill_gap`：纯失败无成功 + 需新能力 |
| 过滤环境噪音 | ✅ | `environment_noise`：样本太少/混合失败类型 |
| 生成 skill spec | ✅ | SpecGenerator：6 套模板 → 结构化 SkillSpec |
| 校准测试 | ✅ | 8/8 场景测试通过 |

### Level 6 — 自己长期成长（学习层）
> 记住经验、调参数、逐步补技能库

| 能力 | 状态 | 实现 |
|------|------|------|
| 记忆失败/成功 | ✅ | Memory 层（10分钟窗口查询） |
| 事实记录 | ✅ | Memory：`recordFact`（位置、死亡等） |
| 策略条目 | ✅ | Memory：`recordStrategy`（什么策略有效） |
| 搜索记忆 | ✅ | `search <q>` 控制台命令 |
| 自动调整参数 | ❌ | 需要调参循环（pending） |
| gap→spec→review 闭环 | ❌ | 半自动，需要人工 merge（pending） |
| 长期世界记忆 | ❌ | 箱子点、家园点、资源趋势（pending） |
| session 统计 | ❌ | 平均在线时长、每次在线收益（pending） |
| 自动化 skill 管道 | ❌ | dev agent 实现 + 沙盒 + merge（pending） |

---

## 5. 关键设计决策

### NaN 策略
**不可根治，可降级**。4层防御：
1. 输入保护（`isFiniteVec3` 守卫）
2. 状态机隔离（PositionHealth → invalid 时取消执行器）
3. 恢复（零速度，2秒窗口，指数退避）
4. 架构去连续化（检查点，短步任务）

### LLM 边界
- **可以**：高层规划、复盘、gap→spec 转换、策略调优
- **禁止**：逐 tick 动作控制、实时移动决策、技能内联编写

### Checkpoint 模型
- 任务进度通过 `X/Y` 正则匹配来跟踪（例如，"Collected 2/5 jungle_log" → 已完成2/5）
- 恢复时，剩余计数被重新入队
- 当任务完全完成时清除检查点

### 控制流原则
- **One body, one driver**：只有 Orchestrator 能下发任务给 Executor
- Safety/PH 可以紧急停 body（`pathfinder.stop` / `clearControlStates`），但不能开路线
- 紧急停完后必须通知 Orchestrator（`raiseEmergency` / `onInvalid`）
- ActionController 锁防止多个模块抢身体

### 双版本策略
- `v5`（`src/`、`bot.js`）— 生产就绪，全功能
- `v6`（`src-ts/`）— TypeScript 分层架构，稳定性优先

---

## 6. 启动方式

```bash
# v6 TypeScript（当前开发）
npm run start:v6          # 或 start-v6.cmd --check

# v5 JavaScript（生产）
npm start                 # 或 npm run start:v5

# 仪表板（v5/v6 均可在 http://localhost:3000 访问）
# 在 v6 中，仪表板随 bot 自动启动

# 运行测试
npm run test:v6           # v6 综合测试 (5/5)
npm run test:gap          # Gap Detector 校准测试 (8/8)
```

### 控制台命令（v6）
```
say <msg>    聊天消息
move x y z   导航至坐标
collect <block> [count]    采集方块
collect2 <block> [count]   短步采集(原子步,断线续传)
scan         显示感知摘要
mem          显示记忆上下文
gap [mins|raw|top]   缺口分析
spec [mins]  生成 skill spec
search <q>   搜索记忆
stop         停止当前任务
status       显示完整状态(任务/行为/step执行器/安全层/目标/控制权)
model <name> 查看/切换 LLM 模型
start        连接服务器
disconnect   断开 bot (不退出进程)
server <host> <port>   切换服务器地址
think        显示上次 LLM 响应
plan <goal>  AI规划(显示[think]推理过程)
quit         关闭
```

---

## 7. 开发命令

```bash
# 类型检查
npx tsc --noEmit

# 运行测试
npx tsx test-v6.ts
npx tsx test-gap-detector.ts

# 启动带检查
start-v6.cmd --check

# 检查日志
Get-Content -LiteralPath "logs/gap-reports.jsonl" -Tail 5
Get-Content -LiteralPath "logs/checkpoint.json"
Get-Content -LiteralPath "logs/step-checkpoint.json"
```
