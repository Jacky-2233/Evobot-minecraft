# EvoBot v7

Minecraft 自主 AI Agent — mineflayer + LLM 驱动

**当前版本**: v7 (`src-ts-v7/`) — 极简 AI 控制架构

---

## 架构概述

```
src-ts-v7/
├── index.ts               # 入口 + 控制台 UI (slash commands)
├── core/bot.ts            # 主控核心 (tick loop / runtime tasks / LLM 决策)
├── types/index.ts         # 类型定义
├── skills/
│   ├── base.ts            # BaseSkill (timeout / retry / cancel)
│   ├── movement.ts        # MoveToSkill
│   ├── collect.ts         # CollectSkill
│   ├── craft.ts           # CraftSkill
│   ├── craft-chain.ts     # CraftChainSkill (gather + craft 连招)
│   ├── eat.ts             # EatSkill
│   └── retreat.ts         # RetreatSkill + attackNearestHostile
└── utils/
    ├── llm.ts             # LLM 客户端 (DeepSeek / Kimi)
    └── nan-guard.ts       # isFiniteVec3
```

---

## 设计原则

- **LLM 负责意图** — 选择下一步做什么、参数是什么、能不能做
- **代码负责执行** — 移动、挖掘、合成全部由确定性技能层完成
- **持续任务对象** — `follow_player` / `search_target` 不是一次性动作，而是持续运行的任务，LLM 可以动态改参数
- **拒绝一定说出来** — 陌生任务会明确评估 `supported/refused/reason`
- **断线按常态处理** — 服务器每 8 秒断线，任务保留重试，不假设持续在线

---

## 安装

```bash
npm install
```

## 配置

编辑 `config.json`:

```json
{
  "minecraft": {
    "host": "127.0.0.1",
    "port": 25565,
    "username": "EvoBot",
    "version": "1.20.1",
    "auth": "offline"
  },
  "ai": {
    "apiKey": "your-key",
    "baseURL": "https://api.deepseek.com/v1",
    "model": "deepseek-v4-flash"
  }
}
```

---

## 启动

```bash
# 推荐
npm start

# 或双击
start-v7.cmd

# 带类型检查
start-v7.cmd --check

# v5 JavaScript 版（备用）
npm run start:v5
```

---

## 控制台命令

启动后底部出现 `/> ` 输入框，输入 `/help` 显示所有命令。

### Core
| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/status` | 完整运行状态 |
| `/target` | 当前任务/目标摘要 |
| `/tasks` | 运行时任务 + 队列 |
| `/clear` | 清空控制台 |
| `/quit` | 退出 |

### 动作
| 命令 | 说明 |
|------|------|
| `/say <msg>` | 发送聊天消息 |
| `/move <x> <y> <z>` | 移动到坐标 |
| `/follow [player] [dist]` | 跟随玩家（持续任务）|
| `/search <target> [entity\|block]` | 搜索目标（持续任务）|
| `/make <item>` | 合成连招 |
| `/stop` | 停止当前所有工作 |

### 感知
| 命令 | 说明 |
|------|------|
| `/scan [query]` | 扫描附近玩家/实体/方块 |
| `/players` | 附近玩家列表 |
| `/entities` | 附近实体列表 |
| `/blocks` | 附近有用方块列表 |

### 模型
| 命令 | 说明 |
|------|------|
| `/model [name]` | 查看/切换 LLM 模型 |

**支持的模型别名:**
- `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-reasoner`
- `kimi-k2.5` / `kimi-k2.6` / `kimi-k2.7` / `kimi-k2.7-code` / `kimi-k2.7-highspeed`

---

## 游戏内聊天命令

直接对 bot 说话，LLM 会理解并执行：

```
follow me          → 跟随你（持续任务）
come here          → 走到你身边
find sheep         → 搜索附近的羊（持续任务）
search coal block  → 搜索附近的煤矿
make a pickaxe     → 合成木镐连招
get some wood      → 采集木头
stop               → 停止所有工作
```

不支持的任务会明确拒绝并告知原因和可用的替代方案。

---

## craft_chain 支持的连招

| 连招 | 步骤 |
|------|------|
| `wooden_pickaxe` | 采 2 木头 → 木板 → 木棍 → 木镐 |
| `crafting_table` | 采 1 木头 → 木板 → 工作台 |
| `stone_pickaxe` | 采木头+采石头 → 木板+木棍 → 石镐 |
| `sticks` | 采木头 → 木板 → 木棍 |
| `furnace` | 采 8 石头 → 熔炉 |

---

## 项目结构

```
mc-bot-evobot/
├── src-ts-v7/         # v7 主线 (当前开发)
├── v5/                # v5 JavaScript 版（备用）
├── archive/v6/        # v6 分层架构（已归档，仅参考）
├── config.json        # 配置文件
├── start-v7.cmd       # Windows 启动脚本
├── package.json
└── tsconfig.json
```

---

## 版本历史

| 版本 | 位置 | 状态 | 说明 |
|------|------|------|------|
| v7 | `src-ts-v7/` | **当前主线** | LLM intent + runtime task + slash console |
| v6 | `archive/v6/` | 已归档 | 分层架构参考（GoalManager/Checkpoint/Dashboard）|
| v5 | `v5/` | 备用 | JavaScript 单文件，稳定可用 |
