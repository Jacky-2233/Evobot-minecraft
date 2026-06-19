/**
 * Dashboard Web Server
 *
 * Serves a monitoring page and provides a WebSocket stream of v6 bot state.
 * Pattern follows the existing src/web/Dashboard.js but consumes DashboardStateProvider.
 */
import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import url from 'url';
import { DashboardStateProvider } from '../layers/dashboard-state.js';

export class DashboardServer {
    private provider: DashboardStateProvider;
    private port: number;
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private clients: WebSocket[] = [];

    constructor(provider: DashboardStateProvider, port: number = 3000) {
        this.provider = provider;
        this.port = port;
    }

    start(): void {
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        this.wss = new WebSocketServer({ server: this.server });
        this.wss.on('error', () => {}); // silently ignore websocket errors

        this.wss.on('connection', (ws) => {
            this.clients.push(ws);
            const state = this.provider.getState();
            ws.send(JSON.stringify({ type: 'state', data: state }));
            ws.on('close', () => {
                this.clients = this.clients.filter((c) => c !== ws);
            });
        });

        this.server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`[Dashboard] Port ${this.port} in use — dashboard already running`);
            }
        });

        this.server.listen(this.port, () => {
            console.log(`[Dashboard] Running at http://localhost:${this.port}`);
        }).on('error', () => {
            // handled above
        });
    }

    /** Call from core tick loop — broadcasts state to connected clients */
    tick(): void {
        if (this.clients.length === 0) return;
        const state = this.provider.getState();
        const msg = JSON.stringify({ type: 'state', data: state });
        for (const ws of this.clients) {
            try { ws.send(msg); } catch {}
        }
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const parsed = url.parse(req.url ?? '/', true);
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (parsed.pathname === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(getHTML());
            return;
        }

        if (parsed.pathname === '/api/state') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(this.provider.getState()));
            return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
    }
}

// ─── HTML Page (inline, dark theme, 7 panels) ───────────

function getHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EvoBot v6 — Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,monospace;background:#0d1117;color:#c9d1d9;padding:12px;min-height:100vh}
h1{font-size:18px;color:#58a6ff;margin-bottom:8px}
h2{font-size:14px;color:#8b949e;margin-bottom:6px}
.topbar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#161b22;border-radius:8px;margin-bottom:10px;font-size:13px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.online{background:#3fb950}
.dot.offline{background:#f85149}
.tag{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.tag.ph-trust{background:#238636;color:#fff}
.tag.ph-degrade{background:#9e6a03;color:#fff}
.tag.ph-invalid{background:#da3633;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.card{background:#161b22;border:1px solid#30363d;border-radius:8px;padding:12px;min-width:0}
.card.wide{grid-column:1/-1}
.val{color:#e6edf3;font-weight:600}
.dim{color:#8b949e;font-size:12px}
.row{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.events{max-height:200px;overflow-y:auto;font-size:12px;line-height:1.6}
.events::-webkit-scrollbar{width:4px}
.events::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.evt{font-family:monospace;padding:1px 0;border-bottom:1px solid#21262d}
.evt .time{color:#8b949e}
.evt .kind{font-weight:600}
.evt.task_start .kind{color:#58a6ff}
.evt.task_ok .kind{color:#3fb950}
.evt.task_fail .kind{color:#f85149}
.evt.disconnect .kind{color:#d29922}
.evt.nan .kind{color:#da3633}
.failrow{font-size:12px;padding:4px 0;border-bottom:1px solid#21262d;display:flex;justify-content:space-between}
.gaprow{font-size:12px;padding:6px 0;border-bottom:1px solid#21262d}
.gaprow .cat{padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
.gaprow .cat.param{background:#238636;color:#fff}
.gaprow .cat.recovery{background:#9e6a03;color:#fff}
.gaprow .cat.precond{background:#1f6feb;color:#fff}
.gaprow .cat.planner{background:#8957e5;color:#fff}
.gaprow .cat.skillgap{background:#da3633;color:#fff}
details{margin:4px 0 0 0;font-size:11px;color:#8b949e}
summary{cursor:pointer;color:#58a6ff}
</style>
</head>
<body>

<div class="topbar" id="topbar">
  <div><span id="statusDot" class="dot offline"></span>
  <span id="statusText" style="margin-left:6px">offline</span></div>
  <span class="dim">|</span>
  <span id="topHP">HP: --</span>
  <span id="topFood">Food: --</span>
  <span class="dim">|</span>
  <span id="topPos">Pos: --</span>
  <span class="dim">|</span>
  <span id="topPH" class="tag">PH: --</span>
  <span style="margin-left:auto;color:#8b949e;font-size:11px" id="topUptime"></span>
</div>

<div class="grid">
  <!-- Bot Status -->
  <div class="card">
    <h2>🤖 Bot Status</h2>
    <div class="row"><span class="dim">Online</span><span class="val" id="botOnline">--</span></div>
    <div class="row"><span class="dim">Server</span><span class="val" id="botServer">--</span></div>
    <div class="row"><span class="dim">Uptime</span><span class="val" id="botUptime">--</span></div>
    <div class="row"><span class="dim">Disconnect</span><span class="val" id="botDisc">--</span></div>
  </div>

  <!-- Survival -->
  <div class="card">
    <h2>❤️ Survival</h2>
    <div class="row"><span class="dim">Health</span><span class="val" id="survHP">--</span></div>
    <div class="row"><span class="dim">Food</span><span class="val" id="survFood">--</span></div>
    <div class="row"><span class="dim">Held</span><span class="val" id="survHeld">--</span></div>
    <div class="row"><span class="dim">In Water</span><span class="val" id="survWater">--</span></div>
    <div class="row"><span class="dim">Pos Health</span>
      <span class="tag" id="survPH">--</span></div>
  </div>

  <!-- Current Goal -->
  <div class="card">
    <h2>🎯 Current Goal</h2>
    <div class="row"><span class="dim">Goal</span><span class="val" id="goalDesc">none</span></div>
    <div class="row"><span class="dim">Type</span><span class="val" id="goalType">--</span></div>
    <div class="row"><span class="dim">Pending</span><span class="val" id="goalPending">0</span></div>
    <details><summary>Queue</summary><div id="goalQueue" style="font-size:11px;color:#8b949e;margin-top:4px">--</div></details>
  </div>

  <!-- Control State -->
  <div class="card">
    <h2>🔒 Control</h2>
    <div class="row"><span class="dim">Owner</span><span class="val" id="ctrlOwner">none</span></div>
    <div class="row"><span class="dim">Last Interrupt</span><span class="val" id="ctrlInterrupt" style="font-size:11px">--</span></div>
    <div class="row"><span class="dim">Force Acquire</span><span class="val" id="ctrlForceAcq" style="font-size:11px">--</span></div>
  </div>

  <!-- Current Task -->
  <div class="card">
    <h2>📋 Current Task</h2>
    <div class="row"><span class="dim">Skill</span><span class="val" id="taskSkill">idle</span></div>
    <div class="row"><span class="dim">Goal</span><span class="val" id="taskGoal">--</span></div>
    <div class="row"><span class="dim">Recovering</span><span class="val" id="taskRecover">no</span></div>
  </div>

  <!-- Checkpoint -->
  <div class="card">
    <h2>💾 Checkpoint</h2>
    <div class="row"><span class="dim">Exists</span><span class="val" id="ckExists">--</span></div>
    <div class="row"><span class="dim">Active Task</span><span class="val" id="ckTask">--</span></div>
    <div class="row"><span class="dim">Progress</span><span class="val" id="ckProgress">--</span></div>
  </div>

  <!-- Recent Events -->
  <div class="card wide">
    <h2>📜 Recent Events</h2>
    <div class="events" id="eventsList">-- waiting for data --</div>
  </div>

  <!-- Recent Failures -->
  <div class="card wide">
    <h2>❌ Recent Failures</h2>
    <div class="events" id="failuresList">-- waiting for data --</div>
  </div>

  <!-- Gap Findings -->
  <div class="card wide">
    <h2>🔍 Gap Findings</h2>
    <div class="events" id="gapsList">-- waiting for data --</div>
  </div>
</div>

<script>
const wsUrl = 'ws://' + location.host;
let ws;
let fallbackTimer;

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.type==='state') render(d.data); } catch{} };
  ws.onclose = () => { setTimeout(connect, 2000); };
}
connect();

function render(s) {
  // Top bar
  const online = s.bot.online;
  document.getElementById('statusDot').className = 'dot ' + (online ? 'online' : 'offline');
  document.getElementById('statusText').textContent = online ? 'online' : (s.bot.reconnecting ? 'reconnecting' : 'offline');
  document.getElementById('topHP').textContent = 'HP: ' + (s.survival.health?.toFixed(0) ?? '--');
  document.getElementById('topFood').textContent = 'Food: ' + (s.survival.food?.toFixed(0) ?? '--');
  const p = s.position;
  document.getElementById('topPos').textContent = p ? 'Pos: (' + p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ', ' + p.z.toFixed(1) + ')' : 'Pos: --';

  // Position health tag color
  const phTag = document.getElementById('topPH');
  const ph = s.survival.positionHealth || 'degraded';
  phTag.textContent = 'PH: ' + ph;
  phTag.className = 'tag ph-' + (ph === 'trusted' ? 'trust' : ph === 'degraded' ? 'degrade' : 'invalid');

  document.getElementById('topUptime').textContent = fmtMs(s.bot.uptimeMs);

  // Bot status card
  document.getElementById('botOnline').textContent = online ? '✓ Online' : '✗ Offline';
  document.getElementById('botServer').textContent = s.bot.server || '--';
  document.getElementById('botUptime').textContent = fmtMs(s.bot.uptimeMs);
  document.getElementById('botDisc').textContent = s.bot.lastDisconnectReason || 'none';

  // Survival
  document.getElementById('survHP').textContent = s.survival.health?.toFixed(0) ?? '--';
  document.getElementById('survFood').textContent = s.survival.food?.toFixed(0) ?? '--';
  document.getElementById('survHeld').textContent = s.survival.heldItem || '--';
  document.getElementById('survWater').textContent = s.survival.inWater ? 'YES' : 'no';
  const ph2 = document.getElementById('survPH');
  ph2.textContent = s.survival.positionHealth;
  ph2.className = 'tag ph-' + (s.survival.positionHealth === 'trusted' ? 'trust' : s.survival.positionHealth === 'degraded' ? 'degrade' : 'invalid');

  // Task
  document.getElementById('taskSkill').textContent = s.task.currentSkill || 'idle';
  document.getElementById('taskGoal').textContent = s.task.currentGoal || '--';
  document.getElementById('taskRecover').textContent = s.task.recovering ? 'YES' : 'no';

  // Goal
  if (s.goal) {
    document.getElementById('goalDesc').textContent = s.goal.activeDescription || 'none';
    document.getElementById('goalType').textContent = s.goal.activeType || '--';
    document.getElementById('goalPending').textContent = s.goal.pendingCount || '0';
    const qDiv = document.getElementById('goalQueue');
    qDiv.innerHTML = (s.goal.queue || []).map(g => '<div>' + esc(g.type) + ': ' + esc(g.description) + '</div>').join('') || '--';
  }

  // Control
  if (s.control) {
    document.getElementById('ctrlOwner').textContent = s.control.owner || 'none';
    document.getElementById('ctrlInterrupt').textContent = s.control.lastInterruptReason || 'none';
    document.getElementById('ctrlForceAcq').textContent = s.control.lastForceAcquireReason || 'none';
  }

  // Checkpoint
  document.getElementById('ckExists').textContent = s.checkpoint.exists ? '✓ Yes' : '✗ No';
  document.getElementById('ckTask').textContent = s.checkpoint.activeTask || '--';
  document.getElementById('ckProgress').textContent = s.checkpoint.progress || '--';

  // Events
  const evDiv = document.getElementById('eventsList');
  evDiv.innerHTML = s.recentEvents.map(e => '<div class="evt ' + e.type + '"><span class="time">' + fmtTime(e.at) + '</span> <span class="kind">[' + e.type + ']</span> ' + esc(e.message) + '</div>').join('') || '-- no events --';

  // Failures
  const fDiv = document.getElementById('failuresList');
  fDiv.innerHTML = s.recentFailures.map(f => '<div class="failrow"><span>' + esc(f.actionKey) + ' <span class="dim">' + f.failReason + '</span></span><span class="dim">' + fmtTime(f.at) + '</span></div>').join('') || '-- no failures --';

  // Gaps
  const gDiv = document.getElementById('gapsList');
  gDiv.innerHTML = s.gapFindings.map(g => {
    const cls = g.category === 'no_gap_param_issue' ? 'param' : g.category === 'no_gap_recovery_issue' ? 'recovery' : g.category === 'no_gap_precondition' ? 'precond' : g.category === 'no_gap_planner_issue' ? 'planner' : 'skillgap';
    let reasons = '';
    if (g.debugReason && g.debugReason.length) {
      reasons = '<details><summary>debugReason</summary><ul>' + g.debugReason.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></details>';
    }
    return '<div class="gaprow"><span class="cat ' + cls + '">' + g.category + '</span> ' + esc(g.summary) + ' <span class="dim">(' + (g.confidence*100).toFixed(0) + '%)</span>' + reasons + '</div>';
  }).join('') || '-- no gap findings --';
}

function fmtMs(ms) { if (!ms || ms <= 0) return '--'; const s = Math.floor(ms/1000); if (s < 60) return s + 's'; const m = Math.floor(s/60); if (m < 60) return m + 'm ' + (s%60) + 's'; const h = Math.floor(m/60); return h + 'h ' + (m%60) + 'm'; }
function fmtTime(ts) { const d = new Date(ts); return d.toISOString().slice(11,19); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;
}
