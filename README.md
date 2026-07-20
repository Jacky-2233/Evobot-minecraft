# EvoBot

Minecraft 自主 AI Agent — **v8 mc-api + Baritone 寻路** 当前主线。

**当前版本: v8.0.0**

| 架构 | 路径 | 后端 | 状态 |
|------|------|------|------|
| **v8** | `src-ts-v8/` | mc-api + Baritone | 当前主线，三层分离 |
| mc-api | `mc-api/` | Fabric 1.21.1 | 自研客户端 API 模组，27 个接口 |
| v7 | `archive/v7/` | mineflayer | **已归档**（RAG/verifier/subgoal 参考实现） |
| v6 | `archive/v6/` | — | 已归档 |
| v5 | `v5/` | — | JavaScript 备用版 |

**关键能力**：原子合成 / A* 寻路 (Baritone) / 远程控制 / 附近感知 / 模组设置 / 容器操作

---

## v8 架构

```text
src-ts-v8/
├── index.ts            # 入口 + 控制台 UI
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

---

## 设计原则

- **LLM 负责意图** — 选择下一步做什么、参数是什么、能不能做
- **代码负责执行** — 移动、挖掘、合成全部由确定性接口层完成
- **mc-api 后端** — 通过 HTTP 暴露 Minecraft 客户端状态和控制，内置 Baritone A* 寻路
- **三层分离** — `api` / `interface` / `agent`，每层职责清晰
- **断线按常态处理** — 服务器每 8 秒断线，任务保留重试，不假设持续在线
- **安全硬编码** — 水中上浮、低血退避、NaN guard 不经过 LLM

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

输入后会自动写入 `config.json`，后续迁移到新机器时直接运行并重新输入即可。

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

也可以从模板复制：

```bash
copy config.example.json config.json
```

---

## 启动

```bash
# 推荐（默认 v8）
npm start

# v8 显式
npm run start:v8

# v5 JavaScript 备用
npm run start:v5
```

---

## 控制台命令

启动后底部出现 `/> ` 输入框。

### Core
| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/setup` | 重新输入 API key / base URL / 模型 / 服务器配置 |
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
| `/move_native <x> <y> <z>` | mc-api 原生移动 |
| `/tap <key>` | 单次按键 |
| `/hold <key> <ms>` | 持续按键 |
| `/look <yaw> <pitch>` | 设置视角 |
| `/hotbar <0-8>` | 切换快捷栏 |
| `/select <name>` | 按名字选物品 |
| `/stop` | 停止当前所有工作 |

### 感知
| 命令 | 说明 |
|------|------|
| `/scan [query]` | 扫描附近玩家/实体/方块 |
| `/players` | 附近玩家列表 |
| `/entities` | 附近实体列表 |
| `/blocks` | 附近有用方块列表 |
| `/inv` | 聚合背包摘要 |
| `/time` | 世界时间 / 天气 |
| `/raycast` | 当前准星命中 |

### 模型
| 命令 | 说明 |
|------|------|
| `/model [name]` | 查看/切换 LLM 模型 |

**支持的模型别名:**
- `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-chat` / `deepseek-reasoner`
- `kimi-k2.5` / `kimi-k2.6` / `kimi-k2.7` / `kimi-k2.7-code` / `kimi-k2.7-highspeed`

---

## mc-api — 自研 Fabric 1.21.1 客户端 API 模组

`mc-api/` 是 EvoBot 的自研后端，通过 HTTP API 暴露 Minecraft 客户端的状态和控制。

**27 个接口**：

| 分类 | 接口 |
|------|------|
| 状态 | `/api/state`, `/api/raycast`, `/api/world/time`, `/api/inventory/summary`, `/api/chat/history` |
| 控制 | `/api/input`, `/api/look`, `/api/stop_all`, `/api/hotbar`, `/api/select_item`, `/api/chat` |
| 动作 | `/api/move_to`, `/api/break_block`, `/api/attack_entity`, `/api/use_item`, `/api/place_block`, `/api/craft` |
| 寻路 | `/api/path_to`（Baritone A* 寻路） |
| 容器 | `/api/inventory/click`, `/api/craft/recipe`, `/api/container/open`, `/api/container/items`, `/api/container/move`, `/api/container/close` |
| 媒体 | `/api/screenshot`, `/api/stream`, `/api/debug/capture` |

**模组命令**：`/mcapi status`, `/mcapi toggle ...`, `/mcapi setws <url>`  

**内置 Baritone 1.21.1 源码**：`mc-api/baritone-src/`

---

## 项目结构

```text
mc-bot-evobot/
├── src-ts-v8/           # v8 mc-api 新主线（三层：api/interface/agent）
├── mc-api/              # Fabric 1.21.1 客户端 API 模组
│   ├── src/main/java/   # Java 源码
│   ├── baritone-src/    # Baritone 1.21.1 完整源码
│   └── build/libs/      # 编译产物
├── archive/
│   ├── v7/              # v7 mineflayer 参考实现（已归档）
│   └── v6/              # v6 分层架构（已归档）
├── v5/                  # v5 JavaScript 版（备用）
├── config.json          # 配置文件（不入库）
└── package.json
```

---

## 版本历史

| 版本 | 位置 | 状态 | 说明 |
|------|------|------|------|
| v8 | `src-ts-v8/` + `mc-api/` | **当前主线** | mc-api + Baritone 寻路 + 三层架构 |
| v7 | `archive/v7/` | 已归档 | LLM intent + RAG + verifier + subgoal |
| v6 | `archive/v6/` | 已归档 | 分层架构参考 |
| v5 | `v5/` | 备用 | JavaScript 单文件 |
