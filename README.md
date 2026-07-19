# EvoBot

Minecraft 自主 AI Agent — v7 mineflayer + v8 mc-api 双路线

**当前版本**:

- `src-ts-v7/`：mineflayer 主线，功能最完整
- `src-ts-v8/`：mc-api 新主线，三层架构（api / interface / agent）

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
    ├── web-knowledge.ts   # 可选外部知识/MCP-style HTTP 查询
    └── nan-guard.ts       # isFiniteVec3
├── memory/                # 本地 RAG/技能/失败记忆
└── planner/               # 轻量任务上下文构建
```

---

## 设计原则

- **LLM 负责意图** — 选择下一步做什么、参数是什么、能不能做
- **代码负责执行** — 移动、挖掘、合成全部由确定性技能层完成
- **持续任务对象** — `follow_player` / `search_target` 不是一次性动作，而是持续运行的任务，LLM 可以动态改参数
- **拒绝一定说出来** — 陌生任务会明确评估 `supported/refused/reason`
- **断线按常态处理** — 服务器每 8 秒断线，任务保留重试，不假设持续在线
- **本地 RAG 优先** — 先检索技能、示例、失败记录，再让 LLM 做意图判断
- **联网可选** — 外部知识查询通过 `EVOBOT_WEB_KNOWLEDGE_URL` 接入，不阻塞核心执行

---

## 安装

```bash
npm install
```

## 配置

首次启动不需要手改配置。程序会在控制台提示输入：

- `Minecraft server`，支持 `host` 或 `host:port`
- `Bot username`
- `AI model`
- DeepSeek / Kimi / Thirdparty 各自独立的 `API key` 和 `base URL`

输入后会自动写入 `config.json`，后续迁移到新机器时，直接运行并重新输入即可。

每个 provider 使用不同的 key 和接口地址，切换模型时会自动切换到对应 provider 的密钥：

```json
{
  "ai": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "providers": {
      "deepseek": {
        "baseURL": "https://api.deepseek.com/v1",
        "apiKey": "sk-your-deepseek-key"
      },
      "kimi": {
        "baseURL": "https://api.moonshot.cn/v1",
        "apiKey": "sk-your-kimi-key"
      },
      "thirdparty": {
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "sk-your-openai-key"
      }
    }
  }
}
```

如果你想手动准备配置，也可以从模板复制：

```bash
copy config.example.json config.json
```

---

## 启动

```bash
# 推荐
npm start

# v7
npm run start:v7

# v8
npm run start:v8

# 或双击
start-v7.cmd

# 带类型检查
start-v7.cmd --check

# v5 JavaScript 版（备用）
npm run start:v5
```

如果之后想重新填写 `API key`、`base URL`、模型或服务器地址，启动后可在控制台执行：

```text
/setup
```

## 本地 RAG / 记忆

v7 会在聊天时自动检索：

- 内置技能库：常见任务的触发词、步骤、成功条件、失败原因
- 示例库：真实玩家口语和对应 intent
- 失败记忆：技能失败会写入 `memories/failures.jsonl`，下次类似请求会被检索进 prompt
- Voyager 风格技能库：支持导入 `skill/description/*.txt + skills.json` 结构
- 任务验证：关键任务会记录执行前后快照，并写入 `logs/task-results.jsonl`

### 直接导入 Voyager 风格 skill library

把技能库目录放到：

```text
memories/voyager-skill-library/
```

支持两种布局：

```text
memories/voyager-skill-library/skill/
  description/
  skills.json
```

或 checkpoint 风格：

```text
memories/voyager-skill-library/<trial-name>/skill/
  description/
  skills.json
```

程序会自动把这些技能描述转成 EvoBot 可检索的本地 skill memory。

另外，仓库已经内置了一份经过 EvoBot 适配的技能包：

- `src-ts-v7/knowledge/skill-packs/voyager-mindcraft-inspired.json`

它直接吸收了 Voyager `trial1` 里最实用的技能类型，例如：

- `craftCraftingTable`
- `craftWoodenPickaxe`
- `craftStonePickaxe`
- `mineWoodLog`
- `mineTenCobblestone`
- `mineFiveCoalOres`
- `craftFurnace`
- `killFourSheep`
- `eatCookedPorkchop` / `eatTwoCookedMutton`
- `smeltRawCopper`

这样你不用自己从零写一堆技能描述，也不用等导入外部库才有这些知识。

目前已经会优先走执行模板的典型请求：

- `collect wood`
- `craft crafting table`
- `craft wooden pickaxe`
- `craft stone pickaxe`
- `craft furnace`
- `mine coal`
- `mine cobblestone`
- `kill sheep`

其中这些合成目标已经不是单步模板，而是会展开成**子目标链**：

- `craft crafting table`
- `craft wooden pickaxe`
- `craft stone pickaxe`
- `craft furnace`

例如 `craft stone pickaxe` 会倾向于拆成：

- collect logs
- craft planks / sticks / crafting table
- craft wooden pickaxe
- collect stone
- craft stone pickaxe

而且现在是 **state-aware** 的：

- 已有 `crafting_table` 就跳过工作台步骤
- 已有 `wooden_pickaxe` 就跳过木镐步骤
- 已有足够 `sticks / planks / stone` 就不重复收集或合成

对于资源类 `search_target`，现在不只是“找到就停”：

- 搜到 `log` 后会自动续接 `collect log`
- 搜到 `coal_ore` 后会自动续接 `collect coal_ore`
- 搜到 `stone` 后会自动续接 `collect stone`

对于一部分实体类目标，也已经开始支持自动续接：

- 搜到 `sheep` 后会自动尝试接 `attack_entity sheep`
- 目标是打通 `search -> 接近 -> 攻击 -> 掉落拾取 -> 结果校验` 这条链

另外，像下面这种失败反馈现在会触发**自动纠偏重规划**：

- `didnt work`
- `failed`
- `没用`
- `失败了`

它会优先参考最近一次失败任务，尝试换成更小、更针对性的补救动作，而不是只回复解释文字。

## 任务验证 / Verifier

当前已经对这些任务做了轻量结果验证：

- `collect`：检查 inventory 是否真的增加
- `craft` / `craft_chain`：检查目标物品是否真的出现在 inventory
- `attack_entity`：检查掉落或附近目标数量是否变化
- `move_to`：检查最终距离是否接近目标

验证结果会写入：

```text
logs/task-results.jsonl
```

查看当前检索上下文：

```text
/memory collect wood
```

## 可选 Web / MCP-style 知识查询

默认不联网。若你有自己的 HTTP/MCP 网关，可以设置：

```bash
set EVOBOT_WEB_KNOWLEDGE_URL=http://127.0.0.1:8080/search
```

网关返回格式支持：

```json
[{"source":"minecraft-wiki","text":"..."}]
```

或：

```json
{"results":[{"source":"minecraft-wiki","text":"..."}]}
```

控制台手动查询：

```text
/web bamboo uses
```

---

## 控制台命令

启动后底部出现 `/> ` 输入框，输入 `/help` 显示所有命令。

### Core
| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/setup` | 重新输入 API key / base URL / 模型 / 服务器配置 |
| `/status` | 完整运行状态 |
| `/target` | 当前任务/目标摘要 |
| `/tasks` | 运行时任务 + 队列 |
| `/memory [query]` | 查看本地 RAG/记忆检索结果 |
| `/web <query>` | 查询可选外部知识/MCP-style 网关 |
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

### v8 / mc-api 扩展命令
| 命令 | 说明 |
|------|------|
| `/move_native <x> <y> <z>` | 使用 mc-api 原生移动 |
| `/tap <key>` | 单次按键 |
| `/hold <key> <ms>` | 持续按键 |
| `/look <yaw> <pitch>` | 设置视角 |
| `/hotbar <0-8>` | 切换快捷栏 |
| `/select <name>` | 按名字选物品 |
| `/inv` | 聚合背包摘要 |
| `/time` | 世界时间 / 天气 |
| `/raycast` | 当前准星命中 |

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
