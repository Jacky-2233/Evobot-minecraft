const fs = require('fs');
const path = require('path');

class Logger {
    constructor(logsDir = path.join(__dirname, '..', '..', 'logs')) {
        this.logsDir = logsDir;
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
        const now = new Date();
        const fileName = `bot_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.log`;
        this.logFilePath = path.join(this.logsDir, fileName);
        this.listeners = [];
    }

    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            const idx = this.listeners.indexOf(callback);
            if (idx !== -1) this.listeners.splice(idx, 1);
        };
    }

    log(...args) {
        const line = `[${new Date().toLocaleTimeString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
        console.log(line);
        try {
            fs.appendFileSync(this.logFilePath, line + '\n');
        } catch (e) {
            // ignore
        }
        this.listeners.forEach(cb => {
            try { cb(line); } catch (e) {}
        });
    }

    info(...args) { this.log('[INFO]', ...args); }
    warn(...args) { this.log('[WARN]', ...args); }
    error(...args) { this.log('[ERROR]', ...args); }
}

module.exports = Logger;
