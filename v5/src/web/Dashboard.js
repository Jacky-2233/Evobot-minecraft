const http = require('http');
const WebSocket = require('ws');
const url = require('url');

class Dashboard {
    constructor(agent) {
        this.agent = agent;
        this.config = agent.config.web;
        this.server = null;
        this.wss = null;
        this.clients = [];
    }

    start() {
        if (!this.config.enabled) return;

        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        this.wss = new WebSocket.Server({ server: this.server });

        this.wss.on('connection', (ws) => {
            this.clients.push(ws);
            ws.send(JSON.stringify({ type: 'status', data: this.getStatus() }));
            ws.on('close', () => {
                const idx = this.clients.indexOf(ws);
                if (idx !== -1) this.clients.splice(idx, 1);
            });
        });

        // Subscribe to logs
        this.agent.logger.subscribe((line) => {
            this.broadcast({ type: 'log', data: line });
        });

        this.server.listen(this.config.port, () => {
            this.agent.log(`[Web] Dashboard running at http://localhost:${this.config.port}`);
        });
    }

    handleRequest(req, res) {
        const parsed = url.parse(req.url, true);
        res.setHeader('Content-Type', 'application/json');

        if (parsed.pathname === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end(this.getHTML());
            return;
        }

        if (parsed.pathname === '/api/status') {
            res.end(JSON.stringify(this.getStatus()));
            return;
        }

        if (parsed.pathname === '/api/chat' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.message && this.agent.bot?.chat) {
                        this.agent.bot.chat(data.message);
                    }
                    if (data.command) {
                        this.agent.handleConsoleCommand(data.command);
                    }
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (parsed.pathname === '/api/config' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.model) {
                        this.agent.setModel(data.model);
                    }
                    if (data.baseURL) {
                        this.agent.config.ai.baseURL = data.baseURL;
                        this.agent.openai.baseURL = data.baseURL;
                        this.agent.log(`[Config] Base URL updated: ${data.baseURL}`);
                    }
                    res.end(JSON.stringify({ ok: true, model: this.agent.config.ai.model, baseURL: this.agent.config.ai.baseURL }));
                } catch (e) {
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (parsed.pathname === '/api/task' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    this.agent.taskQueue.add(data.type, data.params || {}, { priority: data.priority || 5, source: 'web' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (parsed.pathname === '/api/talk' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const message = data.message;
                    if (message && this.agent.bot?.entity && this.agent.chatBrain) {
                        const reply = await this.agent.chatBrain.handleChat('WebUser', message);
                        res.end(JSON.stringify({ ok: true, reply }));
                    } else {
                        res.end(JSON.stringify({ ok: false, error: 'Not ready or no message' }));
                    }
                } catch (e) {
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    getStatus() {
        const bot = this.agent.bot;
        return {
            online: !!bot?.entity,
            username: bot?.username || this.agent.config.minecraft.username,
            health: bot?.health ?? null,
            food: bot?.food ?? null,
            position: bot?.entity?.position ? {
                x: Number.isNaN(bot.entity.position.x) ? '0' : bot.entity.position.x.toFixed(1),
                y: Number.isNaN(bot.entity.position.y) ? '0' : bot.entity.position.y.toFixed(1),
                z: Number.isNaN(bot.entity.position.z) ? '0' : bot.entity.position.z.toFixed(1),
            } : null,
            task: this.agent.taskQueue.getStatus(),
            inventory: this.agent.skills.inventory ? this.agent.skills.inventory.getStatus() : null,
            evolution: this.agent.evolution ? this.agent.evolution.getStats() : null,
        };
    }

    broadcast(data) {
        const msg = JSON.stringify(data);
        this.clients = this.clients.filter(ws => ws.readyState === WebSocket.OPEN);
        this.clients.forEach(ws => {
            try { ws.send(msg); } catch (e) {}
        });
    }

    tick() {
        if (this.clients.length > 0) {
            this.broadcast({ type: 'status', data: this.getStatus() });
        }
    }

    getHTML() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>EvoBot Dashboard</title>
    <style>
        body { font-family: sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #111; color: #eee; }
        h1 { color: #0f0; }
        .card { background: #222; border-radius: 8px; padding: 15px; margin: 10px 0; }
        .stat { display: inline-block; margin-right: 20px; }
        button { background: #0a0; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; margin: 2px; }
        button:hover { background: #0c0; }
        input { padding: 8px; width: 300px; border-radius: 4px; border: 1px solid #555; background: #333; color: white; }
        #logs { height: 300px; overflow-y: auto; background: #000; padding: 10px; font-family: monospace; font-size: 12px; border-radius: 4px; }
        .log-line { margin: 1px 0; }
        .online { color: #0f0; } .offline { color: #f00; }
    </style>
</head>
<body>
    <h1>EvoBot v5.0 Dashboard</h1>
    <div class="card">
        <div class="stat">Status: <span id="status" class="offline">offline</span></div>
        <div class="stat">HP: <span id="hp">-</span></div>
        <div class="stat">Hunger: <span id="food">-</span></div>
        <div class="stat">Pos: <span id="pos">-</span></div>
    </div>
    <div class="card">
        <h3>Talk to EvoBot</h3>
        <input id="chatInput" placeholder="Say something to the bot...">
        <button onclick="talkToBot()">Talk</button>
        <div id="conv" style="margin-top:8px;max-height:150px;overflow-y:auto;background:#000;padding:5px;font-size:12px;"></div>
    </div>
    <div class="card">
        <h3>Commands</h3>
        <button onclick="sendCmd('collect log')">Collect Wood</button>
        <button onclick="sendCmd('collect stone')">Collect Stone</button>
        <button onclick="sendCmd('attack')">Attack</button>
        <button onclick="sendCmd('farm')">Farm</button>
        <button onclick="sendCmd('build')">Build Shelter</button>
        <button onclick="sendCmd('stop')">Stop</button>
    </div>
    <div class="card">
        <h3>AI Model</h3>
        <select id="modelSelect" onchange="changeModel(this.value)">
            <option value="deepseek-chat">DeepSeek Chat</option>
            <option value="deepseek-v4-flash">DeepSeek Flash</option>
            <option value="deepseek-v4-pro">DeepSeek Pro</option>
            <option value="moonshot-v1-8k">Kimi (Moonshot)</option>
        </select>
        <span id="modelStatus" style="margin-left:10px;font-size:12px;color:#888;"></span>
    </div>
    <div class="card">
        <h3>Tasks</h3>
        <div id="tasks">No tasks</div>
    </div>
    <div class="card">
        <h3>Logs</h3>
        <div id="logs"></div>
    </div>
    <script>
        const ws = new WebSocket('ws://' + location.host);
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'status') updateStatus(msg.data);
            if (msg.type === 'log') addLog(msg.data);
        };
        function updateStatus(s) {
            document.getElementById('status').textContent = s.online ? 'online' : 'offline';
            document.getElementById('status').className = s.online ? 'online' : 'offline';
            document.getElementById('hp').textContent = s.health ?? '-';
            document.getElementById('food').textContent = s.food ?? '-';
            document.getElementById('pos').textContent = s.position ? \`\${s.position.x}, \${s.position.y}, \${s.position.z}\` : '-';
            document.getElementById('tasks').textContent = s.task.current
                ? \`Current: \${s.task.current.type} | Queued: \${s.task.queued}\`
                : 'No current task';
        }
        function addLog(line) {
            const div = document.getElementById('logs');
            const p = document.createElement('div');
            p.className = 'log-line';
            p.textContent = line;
            div.appendChild(p);
            div.scrollTop = div.scrollHeight;
        }
        async function talkToBot() {
            const input = document.getElementById('chatInput');
            const msg = input.value.trim();
            if (!msg) return;
            const conv = document.getElementById('conv');
            conv.innerHTML += '<div style="color:#0ff">You: ' + msg + '</div>';
            input.value = '';
            const res = await fetch('/api/talk', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({message: msg}) });
            const data = await res.json();
            if (data.ok && data.reply) {
                conv.innerHTML += '<div style="color:#0f0">EvoBot: ' + data.reply + '</div>';
            } else if (!data.ok) {
                conv.innerHTML += '<div style="color:#f88">Error: ' + (data.error || 'unknown') + '</div>';
            }
            conv.scrollTop = conv.scrollHeight;
        }
        async function sendCmd(text) {
            await fetch('/api/chat', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({command: text}) });
        }
        async function changeModel(val) {
            const res = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({model: val}) });
            const data = await res.json();
            document.getElementById('modelStatus').textContent = data.ok ? '✓ ' + data.model : '✗ error';
            setTimeout(() => document.getElementById('modelStatus').textContent = '', 3000);
        }
    </script>
</body>
</html>`;
    }
}

module.exports = Dashboard;
