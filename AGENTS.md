# EvoBot — 项目状态

> 最后更新：2026-07-20
> **当前版本**: v8 (`src-ts-v8/` + `mc-api/`) — mc-api + Baritone 后端，三层架构
> **已归档**: v7 (`archive/v7/`) — mineflayer AI 驱动参考实现
> **已归档**: v6 (`archive/v6/`) — 分层架构参考
> **备用**: v5 (`v5/`) — JavaScript 生产版

---

## 目录

1. [项目概述](#1-项目概述)
2. [环境与现实约束](#2-环境与现实约束)
3. [v8 架构](#3-v8-架构)
4. [v7 归档说明](#4-v7-归档说明)
5. [能力状态](#5-能力状态)
6. [关键设计决策](#6-关键设计决策)
7. [启动方式](#7-启动方式)
8. [控制台命令](#8-控制台命令)
9. [开发命令](#9-开发命令)

---

## 1. 项目概述

构建一个 Minecraft 自主 AI Agent，目标是"接近人类玩家的稳定行为"，而非短暂演示型智能。

**当前主线**：LLM 意图理解 + mc-api 后端 + Baritone A* 寻路 + 三层执行架构

**演进路线**：
```
v5 JS  → 全功能 bot，单文件架构
v6 TS  → 分层架构，Checkpoint/GoalManager/Dashboard（已归档）
v7 TS  → mineflayer 极简 AI 驱动，LLM intent + runtime tasks + slash console（已归档）
v8 TS  → mc-api 后端 + Baritone 寻路，api/interface/agent 三层分离（当前）
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

## 3. v8 架构

```
src-ts-v8/
├── index.ts            # 入口 + 控制台 UI (slash commands)
├── api/
│   └── mc-api.ts       # mc-api HTTP 客户端
├── interface/
│   └── controller.ts   # 感知 + 动作抽象层
└── agent/
    └── agent.ts        # LLM 决策循环（当前为骨架）

mc-api/
├── src/main/java/      # Fabric 1.21.1 模组源码
├── baritone-src/       # Baritone 1.21.1 完整源码
└── build/libs/         # 编译产物
```

### 控制流

```
玩家 chat / 控制台命令 → agent.ts
                              ↓
                      决策：调用 controller/interface
                              ↓
                      mc-api.ts HTTP 调用 mc-api 后端
                              ↓
                      mc-api 模组 → Minecraft 客户端 / Baritone
```

### 核心原则
- **LLM 只负责意图**：做什么、参数是什么、能不能做
- **interface 负责抽象**：感知、动作封装成统一接口
- **api 负责通信**：HTTP 调用 mc-api 27 个端点
- **Safety hardcoded**：水中上浮、低血退避、NaN guard 不走 LLM
- **三层独立演化**：换后端、换 LLM、换控制策略互不污染

---

## 4. v7 归档说明

v7 实现已完整移至 `archive/v7/`，包含：

- `index.ts` 控制台入口
- `core/bot.ts` 主控核心（tick loop / runtime tasks / task queue / reconnect）
- `skills/` 原子技能（movement / collect / craft / craft-chain / eat / retreat）
- `memory/` 本地 RAG（skill-library / example-library / failure-memory / retrieval）
- `planner/` subgoal-planner / task-planner / verifier
- `utils/` LLM 客户端（多 provider）、web-knowledge、nan-guard

v7 的全部能力描述（生存/移动/采集/合成/决策）保留在该目录的源码中，可作为参考实现。主入口和 `npm start` 不再指向 v7。

---

## 5. 能力状态

### v8 当前能力（基于 mc-api）

| 类别 | 能力 | 状态 | 说明 |
|------|------|------|------|
| 后端 | mc-api 27 接口 | ✅ | 状态、控制、动作、寻路、容器、媒体 |
| 寻路 | Baritone A* | ✅ | `/api/path_to` |
| 控制 | 输入/视角/快捷栏 | ✅ | `/api/input`, `/api/look`, `/api/hotbar` |
| 感知 | 附近扫描 | ✅ | `/api/state`, `/api/raycast` |
| 容器 | 容器交互/合成 | ✅ | `/api/container/*`, `/api/craft/recipe` |
| 决策 | LLM agent 循环 | 🔄 | agent.ts 为骨架，待填充完整决策链 |

### v7 归档能力（参考实现）

| 类别 | 能力 | 状态 | 说明 |
|------|------|------|------|
| 生存 | 落水上浮 / 低血退避 / 自动吃饭 / 断线重连 | ✅ | `archive/v7/core/bot.ts` + skills |
| 移动 | 走到坐标 / 跟随 / 搜索目标 / 路径中断恢复 | ✅ | RuntimeTask + MoveToSkill |
| 采集 | 采木头 / 采石头/矿 | ✅ | CollectSkill |
| 合成 | 木镐/工作台/石镐/熔炉连招 | ✅ | CraftChainSkill，state-aware 子目标链 |
| 决策 | 自主探索 / 陌生任务映射+拒绝 / 玩家命令响应 | ✅ | parseGenericIntent |

### 待实现
- v8 agent.ts 完整决策循环
- v8 本地 RAG / 记忆系统（可复用 v7 memory 模块）
- v8 安全 override（水中、低血、NaN）
- v8 断线重连与任务保留
- v7 的自动拾取、craft 后回收工作台、checkpoint、最小 planner 可迁移到 v8

---

## 6. 关键设计决策

### LLM 边界
- **可以**: 意图理解、参数选择、陌生任务评估、chat 回复
- **禁止**: tick 级移动控制、直接控制 pathfinder

### Intent 协议
LLM 统一输出:
```json
{"intent":"follow_player","supported":true,"player":"Jacky_MC_","distance":12,"tolerance":2}
{"intent":"refuse","supported":false,"reason":"missing_build_skill","fallback":"collect log / craft crafting_table"}
```

### 任务重试策略（继承自 v7）
- `cancelled` / `path_stuck` / `timeout` → 最多重试 2 次
- 断线 (`onEnd`) → 不清空队列，保留任务等重连后继续
- 死亡 → 清空队列

### 水路防御（v7 参考实现）
- pathfinder `liquidCost=100` + `blocksToAvoid.add(water)` + `infiniteLiquidDropdownDistance=false`
- 落水后 tick 级 jump+抬头，不走 pathfinder

---

## 7. 启动方式

```bash
# 推荐（默认 v8）
npm start

# v8 显式
npm run start:v8

# v5 备用
npm run start:v5
```

v7 如需手动运行：

```bash
npx tsx archive/v7/index.ts
```

---

## 8. 控制台命令

启动后底部 `/> ` 输入框，`/help` 查看全部。

### Core
```
/help                         显示帮助
/setup                        重新输入 API key / base URL / 模型 / 服务器配置
/status                       完整运行状态
/target                       当前目标摘要
/tasks                        运行时任务 + 队列
/clear                        清空控制台
/quit                         退出
```

### 动作
```
/say <msg>                    发送聊天消息
/move <x> <y> <z>             移动到坐标
/move_native <x> <y> <z>      mc-api 原生移动
/tap <key>                    单次按键
/hold <key> <ms>              持续按键
/look <yaw> <pitch>           设置视角
/hotbar <0-8>                 切换快捷栏
/select <name>                按名字选物品
/stop                         停止所有工作
```

### 感知
```
/scan [query]                 扫描附近
/players                      附近玩家
/entities                     附近实体
/blocks                       附近方块
/inv                          聚合背包摘要
/time                         世界时间 / 天气
/raycast                      当前准星命中
```

### 模型
```
/model [name]                 查看/切换模型
```

**模型别名**:
```
deepseek-v4-flash  deepseek-v4-pro  deepseek-chat  deepseek-reasoner
kimi-k2.5  kimi-k2.6  kimi-k2.7  kimi-k2.7-code  kimi-k2.7-highspeed
```

---

## 9. 开发命令

```bash
# 类型检查
npx tsc --noEmit

# 启动 v8
npx tsx src-ts-v8/index.ts

# 检查日志
Get-Content -LiteralPath "logs/think.jsonl" -Tail 5
Get-Content -LiteralPath "logs/chat.jsonl" -Tail 5
```
