/**
 * Simple file logger for EvoBot v6.
 * Writes console output to logs/v6-{timestamp}.log with timestamps.
 */
import fs from 'fs';
import path from 'path';

const LOG_DIR = 'logs';

export class FileLogger {
    private stream: fs.WriteStream | null = null;
    private origLog: typeof console.log | null = null;
    private origWarn: typeof console.warn | null = null;
    private origError: typeof console.error | null = null;
    private _enabled = false;

    get enabled(): boolean { return this._enabled; }

    /** Start capturing console.log/warn/error to file */
    start(): void {
        if (this._enabled) return;
        try {
            if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filePath = path.join(LOG_DIR, `v6-${ts}.log`);
            this.stream = fs.createWriteStream(filePath, { flags: 'a' });

            this.stream.write(`=== EvoBot v6 started at ${new Date().toISOString()} ===\n`);

            // Save originals
            this.origLog = console.log;
            this.origWarn = console.warn;
            this.origError = console.error;

            const logStream = this.stream;
            const origLog = this.origLog;
            const origWarn = this.origWarn;
            const origError = this.origError;

            console.log = function (...args: any[]) {
                const prefix = new Date().toISOString().slice(11, 23);
                const msg = `[${prefix}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
                logStream.write(msg + '\n');
                origLog.apply(console, args);
            };

            console.warn = function (...args: any[]) {
                const prefix = new Date().toISOString().slice(11, 23);
                const msg = `[${prefix}] [WARN] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
                logStream.write(msg + '\n');
                origWarn.apply(console, args);
            };

            console.error = function (...args: any[]) {
                const prefix = new Date().toISOString().slice(11, 23);
                const msg = `[${prefix}] [ERROR] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
                logStream.write(msg + '\n');
                origError.apply(console, args);
            };

            this._enabled = true;
            console.log(`[FileLogger] Logging to ${filePath}`);
        } catch (err) {
            console.warn('[FileLogger] Failed to start file logging:', err);
        }
    }

    /** Stop file logging and restore console */
    stop(): void {
        if (!this._enabled || !this.stream) return;
        try {
            this.stream.end();
        } catch {}
        // Restore original console functions
        if (this.origLog) console.log = this.origLog;
        if (this.origWarn) console.warn = this.origWarn;
        if (this.origError) console.error = this.origError;
        this._enabled = false;
        this.stream = null;
    }
}

export const fileLogger = new FileLogger();
