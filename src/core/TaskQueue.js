const fs = require('fs');
const path = require('path');

class TaskQueue {
    constructor(agent, options = {}) {
        this.agent = agent;
        this.tasks = [];
        this.currentTask = null;
        this.persistFile = path.join(process.cwd(), 'memories', 'task_queue.json');
        this.maxHistory = options.maxHistory || 50;
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.persistFile)) {
                const data = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
                this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
            }
        } catch (e) {
            this.tasks = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.persistFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.persistFile, JSON.stringify({ tasks: this.tasks.slice(-this.maxHistory) }, null, 2));
        } catch (e) {}
    }

    add(type, params = {}, options = {}) {
        const task = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            type,
            params,
            priority: options.priority ?? 5,
            createdAt: Date.now(),
            source: options.source || 'system',
            persistent: options.persistent || false,
        };
        this.tasks.push(task);
        this.tasks.sort((a, b) => b.priority - a.priority);
        this.save();
        this.agent.log(`[Task] Added ${type} (${params.target || params.username || ''}) priority=${task.priority}`);
        return task.id;
    }

    remove(id) {
        const idx = this.tasks.findIndex(t => t.id === id);
        if (idx !== -1) {
            const removed = this.tasks.splice(idx, 1)[0];
            this.save();
            return removed;
        }
        return null;
    }

    clear() {
        this.tasks = [];
        this.currentTask = null;
        this.save();
    }

    getNext() {
        // Filter out stale tasks
        this.tasks = this.tasks.filter(t => !t.expiresAt || t.expiresAt > Date.now());
        if (this.tasks.length === 0) return null;
        return this.tasks[0];
    }

    async executeNext() {
        if (this.currentTask || this.tasks.length === 0) return false;

        const task = this.tasks.shift();
        this.currentTask = task;
        this.save();

        this.agent.log(`[Task] Executing ${task.type} (${JSON.stringify(task.params)})`);
        try {
            const result = await this.agent.executeTask(task);
            task.completedAt = Date.now();
            task.success = result;
            this.agent.log(`[Task] ${task.type} ${result ? 'succeeded' : 'failed'}`);
        } catch (e) {
            task.error = e.message;
            task.success = false;
            this.agent.log(`[Task] ${task.type} error:`, e.message);
        } finally {
            this.currentTask = null;
            if (!task.persistent) {
                this.save();
            } else {
                // Re-add persistent tasks with lower priority
                task.priority = Math.max(1, task.priority - 1);
                this.tasks.push(task);
                this.save();
            }
        }
        return true;
    }

    isIdle() {
        return !this.currentTask && this.tasks.length === 0;
    }

    getStatus() {
        return {
            current: this.currentTask,
            queued: this.tasks.length,
            tasks: this.tasks.slice(0, 10),
        };
    }
}

module.exports = TaskQueue;
