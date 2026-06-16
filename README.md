# Evobot Minecraft

Self-evolving Minecraft AI agent — v4.0

## 特性

- ModeController 模式系统（自保/脱困/逃跑/防御/狩猎/捡物）
- EvolutionSystem 进化系统（技能学习/经验记录/自我反思）
- DeepSeek AI 驱动的自然语言交互
- 300ms 更新循环，动作可中断
- 自动重连，持久化记忆

## 依赖

- Node.js 18+
- mineflayer
- mineflayer-pathfinder
- openai

## 启动

```bash
npm install
npm start
```

或双击 `start.bat`

## 配置

编辑 `bot.js` 顶部的 `CONFIG` 对象：

```js
const CONFIG = {
    minecraft: {
        host: '127.0.0.1',
        port: 25565,
        username: 'EvoBot',
        version: '1.20.1',
    },
    ai: {
        apiKey: 'your-deepseek-api-key',
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
    },
};
```

## 控制台命令

| 命令 | 说明 |
|------|------|
| `say <msg>` | 发送聊天消息 |
| `quit` | 退出 |

## 游戏内命令

| 说话内容 | 动作 |
|----------|------|
| 挖/采集/collect/get + 资源名 | 收集资源 |
| 跟随/follow/过来 | 跟随玩家 |
| 停止/stop/别动 | 停止当前任务 |
