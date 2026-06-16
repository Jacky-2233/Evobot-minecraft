# Evobot Minecraft

Self-evolving Minecraft AI agent — **v5.0**

## 特性

- 模块化架构（`src/` 目录）
- 任务队列系统（支持排队多个任务）
- 增强战斗：自动换装武器/盔甲/盾牌、低血量撤退
- 生存系统：自动进食、吃金苹果回血
- 背包管理：自动装备最优工具、丢弃垃圾、自动合成
- 农耕：收割成熟作物并补种
- 建筑：放置方块、建造避难所
- 仓储：寻找附近箱子、存入/取出物品
- 网页控制面板：实时状态、日志、远程命令
- DeepSeek AI 函数调用（支持工具调用）
- EvolutionSystem 进化系统（技能学习/经验记录/自我反思）
- 300ms 更新循环，自动重连，持久化记忆

## 依赖

- Node.js 18+
- mineflayer / mineflayer-pathfinder
- mineflayer-pvp / mineflayer-auto-eat / mineflayer-tool
- openai
- express / ws

## 安装

```bash
npm install
```

## 配置

编辑 `config.json`：

```json
{
  "minecraft": {
    "host": "127.0.0.1",
    "port": 25565,
    "username": "EvoBot",
    "version": "1.20.1"
  },
  "ai": {
    "apiKeyFile": "api_key_DO_NOT_DELETE.txt",
    "baseURL": "https://api.deepseek.com/v1",
    "model": "deepseek-chat"
  },
  "web": {
    "enabled": true,
    "port": 3000
  }
}
```

AI key 也可以直接写 `apiKey`，或设置环境变量 `DEEPSEEK_API_KEY`。

## 启动

```bash
npm start
```

或双击 `start.bat`

启动后打开 Web 面板： http://localhost:3000

## 控制台命令

| 命令 | 说明 |
|------|------|
| `say <msg>` | 发送聊天消息 |
| `follow <player>` | 跟随玩家 |
| `collect <block> [count]` | 收集资源 |
| `attack` | 攻击附近敌对生物 |
| `farm` | 收割并补种作物 |
| `build` | 建造避难所 |
| `deposit [items...]` | 存入箱子 |
| `stop` | 停止当前任务 |
| `status` | 查看状态 |
| `quit` | 退出 |

## 游戏内命令

直接对机器人说话即可，AI 会理解并执行：

- "去砍点木头" → `[DO:collect:log]`
- "跟我来" → `[DO:follow]`
- "攻击怪物" → `[DO:attack]`
- "收割庄稼" → `[DO:farm]`
- "停止" → `[DO:stop]`

## 项目结构

```
mc-bot-evobot/
├── bot.js              # 入口
├── config.json         # 配置
├── src/
│   ├── core/           # Agent / ModeController / TaskQueue / Config / EvolutionSystem
│   ├── skills/         # movement / combat / survival / inventory / gather / farming / building / storage
│   ├── ai/             # ChatBrain
│   ├── web/            # Dashboard
│   └── utils/          # logger / world
├── memories/           # 对话记忆
├── evolution/          # 进化数据
└── logs/               # 运行日志
```
