const fs = require('fs');
const path = require('path');

let puppeteer;
try {
    puppeteer = require('puppeteer-core');
} catch (e) {
    puppeteer = null;
}

let prismarineViewer;
try {
    prismarineViewer = require('prismarine-viewer').mineflayer;
} catch (e) {
    prismarineViewer = null;
}

/**
 * Renders the bot's first-person view using prismarine-viewer and captures
 * screenshots via a headless browser (puppeteer-core).
 *
 * NOTE: prismarine-viewer requires the native 'canvas' package. If canvas
 * cannot be installed (e.g. missing Visual Studio Build Tools on Windows),
 * this skill will gracefully report that first-person rendering is unavailable.
 */
class ViewerSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.config = agent.config.viewer || {};
        this.viewer = null;
        this.url = null;
        this.browser = null;
        this.page = null;
        this.started = false;
        this.missingReason = null;
        if (!prismarineViewer) {
            this.missingReason = 'prismarine-viewer or its native dependency (canvas) is not installed';
        } else if (!puppeteer) {
            this.missingReason = 'puppeteer-core is not installed';
        }
    }

    isEnabled() {
        return this.config.enabled !== false && !!prismarineViewer && !!puppeteer;
    }

    findBrowserExecutable() {
        if (this.config.browserExecutable && fs.existsSync(this.config.browserExecutable)) {
            return this.config.browserExecutable;
        }
        const candidates = [
            process.env.PUPPETEER_EXECUTABLE_PATH,
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ].filter(Boolean);
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        return null;
    }

    async start() {
        if (this.started) return true;
        if (!this.isEnabled()) {
            throw new Error('Viewer not enabled or puppeteer-core not installed');
        }

        const browserPath = this.findBrowserExecutable();
        if (!browserPath) {
            throw new Error('No Chrome/Edge executable found. Set viewer.browserExecutable in config.json.');
        }

        this.agent.log(`[Viewer] Starting first-person viewer on port ${this.config.port || 3001}...`);

        try {
            prismarineViewer(this.bot, {
                port: this.config.port || 3001,
                firstPerson: true,
                viewDistance: this.config.viewDistance || 4,
            });
            this.url = `http://127.0.0.1:${this.config.port || 3001}`;
        } catch (e) {
            throw new Error(`Failed to start prismarine-viewer: ${e.message}`);
        }

        // Wait a moment for the server to start
        await new Promise(r => setTimeout(r, 1500));

        try {
            this.browser = await puppeteer.launch({
                executablePath: browserPath,
                headless: this.config.headless !== false ? 'new' : false,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
            });
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 640, height: 480 });
            await this.page.goto(this.url, { waitUntil: 'networkidle2', timeout: 20000 });
            // Wait for the canvas / world to render
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            this.stop();
            throw new Error(`Failed to launch browser: ${e.message}`);
        }

        this.started = true;
        this.agent.log('[Viewer] Ready');
        return true;
    }

    async capture() {
        if (!this.started) {
            await this.start();
        }
        if (!this.page) throw new Error('Viewer page not ready');

        // Give it a moment to render latest frame
        await new Promise(r => setTimeout(r, 500));

        try {
            const screenshot = await this.page.screenshot({ type: 'png', encoding: 'base64' });
            return `data:image/png;base64,${screenshot}`;
        } catch (e) {
            throw new Error(`Screenshot failed: ${e.message}`);
        }
    }

    async captureToFile(filePath) {
        if (!this.started) await this.start();
        if (!this.page) throw new Error('Viewer page not ready');
        await new Promise(r => setTimeout(r, 500));
        await this.page.screenshot({ path: filePath, type: 'png' });
        return filePath;
    }

    stop() {
        try { this.page?.close(); } catch (e) {}
        try { this.browser?.close(); } catch (e) {}
        this.page = null;
        this.browser = null;
        this.started = false;
        this.url = null;
    }
}

module.exports = ViewerSkill;
