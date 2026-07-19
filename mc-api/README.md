# mc-api

一个基于 Fabric 1.21.1 的客户端模组，把 Minecraft 客户端状态、感知、输入和部分原子动作暴露为本地 HTTP API，供 agent / EvoBot v8 调用。

当前已实现：

1. 状态 API：坐标、血量、饥饿值、护甲、朝向、俯仰角、背包、快捷栏、经验、世界/服务器信息、玩家列表、附近实体、附近有用方块、raycast 等
2. 输入 API：按键、视角、切槽、停止所有输入、聊天
3. 原子动作 API：原生 `move_to`、`break_block`、`attack_entity`、`use_item`、`place_block`、`craft`
4. 容器 / 背包 API：背包摘要、按名称选物品、inventory click、container open/items/move/close
5. 截图 / 视频流 / debug capture
6. 客户端命令配置：`/mcapi status`、`/mcapi toggle ...`、`/mcapi setws ...`

## 接口

服务启动后监听：`http://127.0.0.1:38888`

## 接口总览

### 状态 / 感知

- `GET /api/state`
- `GET /api/raycast`
- `GET /api/world/time`
- `GET /api/inventory/summary`
- `GET /api/chat/history`

`/api/state` 会返回几乎所有玩家/世界信息，包括：

- 坐标 / block 坐标
- yaw / pitch / headYaw
- 血量 / 饥饿 / 护甲 / 经验
- 主手 / 副手 / 装备 / 全背包
- 时间 / 生物群系 / 维度 / 难度 / 模式
- 玩家列表
- nearbyEntities
- nearbyBlocks
- keys

### 输入 / 控制

- `POST /api/input`
- `POST /api/look`
- `POST /api/stop_all`
- `POST /api/hotbar`
- `POST /api/select_item`
- `POST /api/chat`

### 原子动作

- `POST /api/move_to`
- `POST /api/break_block`
- `POST /api/attack_entity`
- `POST /api/use_item`
- `POST /api/place_block`
- `POST /api/craft`

### 容器 / 背包

- `POST /api/inventory/click`
- `POST /api/craft/recipe`
- `POST /api/container/open`
- `GET /api/container/items`
- `POST /api/container/move`
- `POST /api/container/close`

### 截屏

`GET /api/screenshot`

返回当前 Minecraft 窗口的 JPEG 截图。

### 实时视频流

`GET /api/stream`

返回 `multipart/x-mixed-replace` MJPEG 实时流，浏览器 `<img>` 标签可直接播放。流率 100fps。

### 控制按键

`POST /api/input`

现在支持几乎所有按键：
- 字母 `a-z`
- 数字 `0-9`
- 功能键 `f1` - `f12`
- 方向键 `up/down/left/right`
- 修饰键 `shift` / `ctrl` / `alt`（左右可用 `lshift` / `rshift` 等）
- 常用键 `space` / `enter` / `tab` / `escape` / `backspace` / `delete` / `insert` / `home` / `end` / `pageup` / `pagedown`
- 小键盘 `num_0` - `num_9` / `num_add` / `num_subtract` / `num_multiply` / `num_divide` / `num_decimal` / `num_enter`
- 鼠标 `left_mouse` / `right_mouse` / `middle_mouse`

请求体示例：

```json
{
  "key": "w",
  "pressed": true
}
```

### 设置视角

`POST /api/look`

```json
{
  "yaw": 90,
  "pitch": 0
}
```

### 原生移动

`POST /api/move_to`

```json
{
  "x": 12,
  "y": 63,
  "z": 95,
  "reachDistance": 1.5,
  "timeoutMs": 20000
}
```

### 挖方块

`POST /api/break_block`

可仅传 `timeoutMs`（使用当前准星），也可传坐标：

```json
{
  "x": -2,
  "y": 63,
  "z": 59,
  "timeoutMs": 8000
}
```

### 攻击实体

`POST /api/attack_entity`

```json
{
  "target": "pig",
  "timeoutMs": 6000
}
```

### 原子合成

`POST /api/craft`

```json
{
  "itemId": "oak_planks",
  "makeAll": false
}
```

这个接口会把合成当成一个完整动作处理：开背包、点配方、取出输出、关闭背包、返回 `inventoryDelta`。

### 选择物品

`POST /api/select_item`

```json
{
  "name": "oak_log"
}
```

### 世界时间

`GET /api/world/time`

释放按键：

```json
{
  "key": "w",
  "pressed": false
}
```



## 客户端命令

在游戏内可直接用：

```text
/mcapi status
/mcapi toggle http true
/mcapi toggle screenshot false
/mcapi toggle stream false
/mcapi toggle ws true
/mcapi setws ws://127.0.0.1:38999/ws
```

设置会保存在：

```text
config/mc-api.json
```

## 说明

1. 这是客户端模组，不是服务端 Bukkit/Spigot/Paper 插件。
2. API 只监听本机 `127.0.0.1`，默认不对局域网开放。
3. 这里的按键是按物理键名注入，不跟随玩家自定义键位绑定变化。
4. `r` 和 `t` 会作为一次普通按键点击注入，具体行为仍由当前客户端界面和游戏状态决定。

## 运行

你需要本机安装 Java 21，并准备 Gradle 或 Gradle Wrapper。

常见启动方式：

```bash
D:\gradle\gradle-8.10.2\bin\gradle.bat runClient
```
如果 SSL 证书正常，也可以用 wrapper：
```bash
gradlew.bat runClient
```

## 本地 smoke test

仓库自带一个快速测试脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\mc-api\debug\test.ps1
```

会依次测试：

- state
- time
- inventory summary
- raycast
- look
- hotbar
- select_item
- stop_all
- chat
- use_item
- move_to
- break_block
- attack_entity
- place_block
- container
- craft
- screenshot / debug
- chat history
