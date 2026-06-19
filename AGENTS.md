# EvoBot v6 — 项目状态

> 最后更新：2026-06-19  
> 双版本并存：`v5`（`src/`、`bot.js`）| `v6`（`src-ts/`）  
> 当前阶段：Phase 2 真实环境校准

---

## 目录

1. [项目概述](#1-项目概述)
2. [环境与现实约束](#2-环境与现实约束)
3. [v6 架构](#3-v6-架构)
4. [已完成的模块](#4-已完成的模块)
5. [关键设计决策](#5-关键设计决策)
6. [启动方式](#6-启动方式)
7. [开发命令](#7-开发命令)
8. [待办事项](#8-待办事项)

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
├── types/index.ts          # 完整类型系统
├── skills/                 # 确定性底层技能
│   ├── base.ts             #   BaseSkill 抽象类 (timeout/retry/cancel)
│   ├── movement.ts         #   MoveToSkill (NaN guard, pathfinding)
│   ├── collect.ts          #   CollectSkill (block scan, tool equip)
│   ├── pickup.ts           #   PickupSkill (dropped item scan+collect)
│   └── combat.ts           #   RetreatSkill + attackNearestHostile
├── executor/executor.ts    # 优先级队列任务执行器
├── layers/                 # 功能层（不依赖启动顺序）
│   ├── perception.ts       #   世界感知 (实体/方块/时间扫描)
│   ├── safety.ts           #   安全层 (敌对规避/卡死恢复/饥饿)
│   ├── position-health.ts  #   位置状态机 (trusted/degraded/invalid)
│   ├── checkpoint.ts       #   检查点管理 (save/load/resume)
│   ├── memory.ts           #   记忆层 (失败/成功记录/查询)
│   ├── behavior.ts         #   行为引擎 (闲逛/采集/自动吃/社交/pickup)
│   ├── gap-detector.ts     #   技能缺口检测器 (6级规则分类)
│   ├── spec-generator.ts   #   Spec生成器 (GapFinding→SkillSpec)
│   ├── planner.ts          #   LLM规划器 (目标→计划生成+复盘)
│   └── dashboard-state.ts  #   仪表板状态聚合器
├── web/dashboard.ts        # 仪表板 HTTP+WS 服务器 (7面板HTML)
├── utils/
│   └── nan-guard.ts        # isFiniteVec3, NaNTracer (20条环形缓冲)
├── core/bot.ts             # 核心入口 (bot初始化+层串联+重连)
└── index.ts                # 启动入口 (配置加载+控制台命令)
```

### 层间数据流

```
Planner (LLM, 高层) → Behavior Engine (规则, 中断时) → Safety (生存, 暂停下层)
                                                              ↓
Perception → PositionHealth → Executor → Skills (move/collect/pickup/retreat)
                                        ↓
                              Memory ← Checkpoint (5s/断连 落盘)
                                ↓
                          GapDetector → SpecGenerator
                                ↓
                          Dashboard (HTTP:3000, 7面板)
```

---

## 4. 已完成的模块

### 4.1 技能系统
| 技能 | 文件 | 描述 |
|------|------|------|
| `move_to` | `skills/movement.ts` | 路径导航至坐标，NaN守卫，卡死检测，信号取消 |
| `collect` | `skills/collect.ts` | 特定方块的挖掘采集，工具换装，dig 重试 |
| `pickup` | `skills/pickup.ts` | 扫描并拾取附近掉落物实体 |
| `retreat` | `skills/combat.ts` | 远离危险；`attackNearestHostile` 内联函数 |

### 4.2 执行器
- 优先级队列（SURVIVAL 100 → IDLE 0）
- 单任务执行（安全第一）
- `onTaskStart` / `onComplete` 回调（用于 memory + dashboard + checkpoint）
- 当 PositionHealth 为 invalid 时取消当前任务

### 4.3 功能层
| 层 | 文件 | 关键特性 |
|-----|------|------------|
| Perception | `perception.ts` | 实体扫描（敌对/玩家/动物/物品分类），方块扫描（按名称分组），日夜检测 |
| Safety | `safety.ts` | 敌对规避、卡死恢复、饥饿处理、伤害处理（`onDamaged`），生成宽限期 10秒 |
| PositionHealth | `position-health.ts` | 3 状态机：trusted→degraded→invalid；invalid 时阻止所有危险操作；自动恢复：invalid→degraded(3s)→trusted |
| Checkpoint | `checkpoint.ts` | `logs/checkpoint.json`；每5秒 + 断开连接时保存；生成时恢复未完成任务 |
| Memory | `memory.ts` | task 成功/失败、gap 报告、事实、策略条目；10分钟窗口查询 |
| Behavior | `behavior.ts` | 优先级行为：自动吃饭、采集、闲逛、社交、拾取掉落物 |
| GapDetector | `gap-detector.ts` | **8/8 校准通过**；6级规则分类链；debugReason 审计跟踪；jsonl 落盘 `logs/gap-reports.jsonl` |
| SpecGenerator | `spec-generator.ts` | 6 套 gap 签名模板 → 结构化 SkillSpec；`spec [mins]` 控制台命令 |
| Planner | `planner.ts` | LLM 目标→计划生成+复盘+重规划 |
| Dashboard | `web/dashboard.ts` | 仪表板服务器位于 `http://localhost:3000`；实时状态 + 7面板 HTML；`/api/state` 端点 |

### 4.4 稳定性基础设施
| 特性 | 描述 |
|------|------|
| 指数退避重连 | 5→10→20→40→80→120s，生成时重置 |
| 自动进食 | `mineflayer-auto-eat`（`.loader` 导出） |
| NaN 追踪器 | 20条环形缓冲区，NaN 时转储 |
| `isFiniteVec3` | attack/lookAt/pathfinder.setGoal 守卫 |
| physicsTick NaN 容忍 | 2秒恢复窗口，零速度，清除控制状态 |
| 健康处理器错误保护 | try-catch 围绕整个 health 事件处理器 |

### 4.5 测试
| 测试 | 文件 | 结果 |
|------|------|--------|
| Gap Detector 校准 | `test-gap-detector.ts` | 8/8 通过 + SpecGenerator 签名验证 |

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

### 双版本策略
- `v5`（`src/`、`bot.js`）— 生产就绪，全功能
- `v6`（`src-ts/`）— TypeScript 分层架构，稳定性优先

---

## 6. 启动方式

```bash
# v6 TypeScript（当前开发）
npx tsx src-ts/index.ts

# v5 JavaScript（生产）
node bot.js

# 仪表板（v5/v6 均可在 http://localhost:3000 访问）
# 在 v6 中，仪表板随 bot 自动启动
# 在 v5 中，仪表板由 src/web/Dashboard.js 在 Agent.js 中启动

# 运行测试
npx tsx test-gap-detector.ts
```

### 控制台命令（v6）
```
say <msg>    聊天消息
move x y z   导航至坐标
collect <block> [count]    采集方块
scan         显示感知摘要
mem          显示记忆上下文
gap [mins|raw|top]   缺口分析
spec [mins]  生成 skill spec
search <q>   搜索记忆
stop         停止当前任务
status       显示队列/记忆/安全状态
quit         关闭
```

---

## 7. 开发命令

```bash
# 类型检查
npx tsx --check src-ts/index.ts

# 运行校准测试
npx tsx test-gap-detector.ts

# 检查日志
Get-Content -LiteralPath "logs/gap-reports.jsonl" -Tail 5
Get-Content -LiteralPath "logs/checkpoint.json"
```

---

## 8. 待办事项

### 短期（Phase 2 — 当前）
- [ ] 真实环境运行 1~3 天，收集真实 gap 报告
- [ ] 人工筛选高价值 skill_gap 发现
- [ ] 校准 PositionHealth 行为边界

### 中期（Phase 3）
- [ ] Planner 读取 recent gap report 避开高风险动作
- [ ] 将从真实环境确认的 skill_gap 转为 spec
- [ ] 由开发 agent 实现新 skill，沙盒测试，人工合并

### 后续
- [ ] 短步执行器（子 token 任务切片）
- [ ] 长期世界记忆（家园点、箱子点、资源点）
- [ ] 资源趋势仪表板
- [ ] Session 统计（平均在线时长、每次在线收益）
- [ ] 自动化 skill 验证管道
