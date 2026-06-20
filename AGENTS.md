# EvoBot — 项目状态

> 最后更新：2026-06-20
> **当前版本**: v7 (`src-ts-v7/`) — AI 驱动，极简架构
> **已归档**: v6 (`archive/v6/`) — 分层架构参考
> **备用**: v5 (`v5/`) — JavaScript 生产版

---

## 目录

1. [项目概述](#1-项目概述)
2. [环境与现实约束](#2-环境与现实约束)
3. [v7 架构](#3-v7-架构)
4. [能力状态](#4-能力状态)
5. [关键设计决策](#5-关键设计决策)
6. [启动方式](#6-启动方式)
7. [控制台命令](#7-控制台命令)
8. [开发命令](#8-开发命令)

---

## 1. 项目概述

构建一个基于 `mineflayer` 的 Minecraft 自主 AI Agent。目标是"接近人类玩家的稳定行为"，而非短暂演示型智能。

**当前主线**：LLM 意图理解 + 持续任务对象 + 工具层执行

**演进路线**：
```
v5 JS → 全功能 bot，单文件架构
v6 TS → 分层架构，Checkpoint/GoalManager/Dashboard（已归档）
v7 TS → 极简 AI 驱动，LLM intent + runtime tasks + slash console
```

---

## 2. 环境与现实约束

### 服务器状态
- 服务器 `127.0.0.1:25565`，离线模式，1.20.1
- **服务器会在约 8 秒主动断开连接**（ECONNRESET）
- **任务必须在短连接窗口内完成，长路径/大任务不可行**

### 核心约束
1. 不假设持续在线 — 断线按常态处理，任务保留重试
2. 不假设 position 永远可信 — NaN guard 保护
3. 不假设 pathfinder 能稳定跑完长路径 — 短步任务
4. LLM 负责意图选择，不负责 tick 级控制

---

## 3. v7 架构

```
src-ts-v7/
├── index.ts               # 入口 + 控制台 UI (slash commands / fixed prompt)
├── core/bot.ts            # 主控核心
│     tick loop            #   updateIntervalMs 循环
│     RuntimeTask          #   follow_player / search_target 持续任务
│     TaskQueue            #   原子技能队列 (collect/craft/move/eat/retreat)
│     LLM intent loop      #   parseGenericIntent → intentToAction
│     Safety               #   水中上浮/低血退避/NaN guard (hardcoded)
│     Reconnect            #   指数退避重连 + 完整事件重绑定
├── types/index.ts         # BotConfig / SkillResult / FailureType
├── skills/
│   ├── base.ts            # BaseSkill (timeout/retry/cancel/AbortController)
│   ├── movement.ts        # MoveToSkill (GoalNear, NaN guard)
│   ├── collect.ts         # CollectSkill (findBlock + GoalNear + dig)
│   ├── craft.ts           # CraftSkill (bot.registry, place table)
│   ├── craft-chain.ts     # CraftChainSkill (gather+craft 连招)
│   ├── eat.ts             # EatSkill
│   └── retreat.ts         # RetreatSkill + attackNearestHostile
└── utils/
    ├── llm.ts             # callLLM (DeepSeek/Kimi, model alias, provider switch)
    └── nan-guard.ts       # isFiniteVec3
```

### 控制流

```
玩家 chat → handleChat → parseGenericIntent → intentToAction
                                  ↓
                         RuntimeTask (follow/search)
                         TaskQueue   (collect/craft/move/eat/retreat)
                                  ↓
autonomous tick → askAI → parseGenericIntent → intentToAction
                                  ↓
                         Safety override (water/health/NaN)
                                  ↓
                              Skills → mineflayer
```

### 核心原则
- **RuntimeTask**: 持续运行的任务（`follow_player` / `search_target`），每 tick 纠偏误差
- **TaskQueue**: 原子技能队列，失败可重试（cancelled/path_stuck/timeout 最多 2 次）
- **Intent layer**: LLM 输出 `{intent, supported, reason}` — 不会做的明确拒绝
- **Safety hardcoded**: 水中上浮、低血退避不走 LLM

---

## 4. 能力状态

### 生存
| 能力 | 状态 | 实现 |
|------|------|------|
| 落水上浮 | ✅ | tick 检测水块 → jump + 抬头，pathfinder 避水 |
| 低血退避 | ✅ | criticalHealthThreshold → RetreatSkill (单锁) |
| 自动吃饭 | ✅ | mineflayer-auto-eat + EatSkill |
| 断线重连 | ✅ | 指数退避 + 完整事件重绑定 + 任务保留 |

### 移动
| 能力 | 状态 | 实现 |
|------|------|------|
| 走到坐标 | ✅ | MoveToSkill / GoalNear |
| 跟随玩家 | ✅ | RuntimeTask follow_player，持续误差修正 |
| 搜索目标 | ✅ | RuntimeTask search_target，环形探索 |
| 路径中断恢复 | ✅ | 断线保留任务，最多重试 2 次 |

### 采集
| 能力 | 状态 | 实现 |
|------|------|------|
| 采木头 | ✅ | CollectSkill + 早期自动触发（木材 < 6） |
| 采石头/矿 | ✅ | CollectSkill |
| 自动拾取 | ❌ | 未实现 PickupSkill |

### 合成
| 能力 | 状态 | 实现 |
|------|------|------|
| 木镐连招 | ✅ | CraftChainSkill |
| 工作台连招 | ✅ | CraftChainSkill |
| 石镐连招 | ✅ | CraftChainSkill |
| 熔炉连招 | ✅ | CraftChainSkill |

### 决策
| 能力 | 状态 | 实现 |
|------|------|------|
| 自主探索 | ✅ | LLM 选 move_to 坐标，2s 决策冷却 |
| 陌生任务映射 | ✅ | parseGenericIntent → 已有工具 |
| 陌生任务拒绝 | ✅ | supported=false + reason + fallback |
| 玩家命令响应 | ✅ | chat → LLM intent → 执行或拒绝并说明 |

### 待实现
- 自动拾取地面物品
- craft 完成后回收工作台
- 轻量 checkpoint（断线后恢复当前任务进度）
- 最小 planner（陌生任务 → search+collect+craft 自动接续）
- /watch 实时状态刷新

---

## 5. 关键设计决策

### LLM 边界
- **可以**: 意图理解、参数选择、陌生任务评估、chat 回复
- **禁止**: tick 级移动控制、直接控制 pathfinder/pathfinder.goto

### RuntimeTask 模型
- `follow_player`: 持续跟随，每 1s 刷新 goal，误差带内停住看向玩家
- `search_target`: 先扫描，找不到则锚点环形探索，超出 maxSearchDistance 失败
- 两种任务都支持 `interrupt/resume`（水中、低血时暂停，恢复后继续）

### Intent 协议
LLM 统一输出:
```json
{"intent":"follow_player","supported":true,"player":"Jacky_MC_","distance":12,"tolerance":2}
{"intent":"refuse","supported":false,"reason":"missing_build_skill","fallback":"collect log / craft crafting_table"}
```

### 任务重试策略
- `cancelled` / `path_stuck` / `timeout` → 最多重试 2 次
- 断线 (`onEnd`) → 不清空队列，保留任务等重连后继续
- 死亡 → 清空队列

### 水路防御
- pathfinder `liquidCost=100` + `blocksToAvoid.add(water)` + `infiniteLiquidDropdownDistance=false`
- 落水后 tick 级 jump+抬头，不走 pathfinder

---

## 6. 启动方式

```bash
# 推荐
npm start

# 双击
start-v7.cmd

# 带类型检查
start-v7.cmd --check

# v5 备用
npm run start:v5
```

---

## 7. 控制台命令

启动后底部 `/> ` 输入框，`/help` 查看全部。

```
/help                         显示帮助
/status                       完整运行状态
/target                       当前目标摘要
/tasks                        运行时任务 + 队列
/scan [query]                 扫描附近
/players                      附近玩家
/entities                     附近实体
/blocks                       附近方块
/say <msg>                    发送聊天
/move <x> <y> <z>             走到坐标
/follow [player] [dist]       跟随玩家（持续）
/search <target> [kind]       搜索目标（持续）
/make <item>                  合成连招
/model [name]                 查看/切换模型
/stop                         停止所有工作
/clear                        清空控制台
/quit                         退出
```

**模型别名**:
```
deepseek-v4-flash  deepseek-v4-pro  deepseek-chat  deepseek-reasoner
kimi-k2.5  kimi-k2.6  kimi-k2.7  kimi-k2.7-code  kimi-k2.7-highspeed
```

---

## 8. 开发命令

```bash
# 类型检查
npx tsc --noEmit

# 启动
npx tsx src-ts-v7/index.ts

# 检查日志
Get-Content -LiteralPath "logs/think.jsonl" -Tail 5
Get-Content -LiteralPath "logs/chat.jsonl" -Tail 5
```
