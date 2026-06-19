const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Image recognition / vision skill.
 * Downloads/fetches an image and asks a vision-capable LLM to describe it.
 * Supports HTTP(S) URLs, local file paths, and base64 data URIs.
 */
class VisionSkill {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.config = agent.config.vision || {};
        // Use a dedicated OpenAI-compatible client if vision config differs from main AI
        const OpenAI = require('openai');
        this.openai = new OpenAI({
            apiKey: this.config.apiKey || agent.config.ai.apiKey,
            baseURL: this.config.baseURL || agent.config.ai.baseURL,
        });
        this.model = this.config.model || agent.config.ai.model;
    }

    isEnabled() {
        if (this.config.enabled === false) return false;
        // Vision requires a vision-capable model. If a dedicated API key is
        // configured for vision, consider it enabled. Otherwise, only enable
        // if the main AI model is known to support image input — this avoids
        // falling back to a text-only model (e.g. DeepSeek) that will reject
        // image requests and waste API calls.
        if (this.config.apiKey) return true;
        const mainModel = (this.agent.config.ai.model || '').toLowerCase();
        const VISION_CAPABLE = ['gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'claude-3', 'kimi', 'qwen-vl', 'glm-4v', 'gemini'];
        return VISION_CAPABLE.some(m => mainModel.includes(m));
    }

    /**
     * Analyze an image source and return a short description.
     * @param {string} source - URL, local path, or base64 data URI
     * @param {string} [prompt] - Optional custom prompt
     */
    async analyze(source, prompt = 'Describe this image concisely in 1-2 sentences.') {
        if (!this.isEnabled()) {
            return 'Vision is not configured.';
        }

        let base64Image;
        try {
            base64Image = await this.loadImage(source);
        } catch (e) {
            return `Failed to load image: ${e.message}`;
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.timeout || 20000);

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: base64Image } },
                        ],
                    },
                ],
                max_tokens: this.config.maxTokens || 200,
                temperature: 0.5,
            }, { signal: controller.signal });

            clearTimeout(timeout);
            return response.choices?.[0]?.message?.content?.trim() || 'No description.';
        } catch (e) {
            this.agent.log('[Vision] Analysis error:', e.message);
            return `Analysis failed: ${e.message}`;
        }
    }

    async loadImage(source) {
        if (!source) throw new Error('No image source provided');

        // Capture bot's first-person view
        if (source === 'viewer:' || source === 'screen' || source === 'view') {
            if (!this.agent.skills.viewer.isEnabled()) {
                const reason = this.agent.skills.viewer.missingReason || 'viewer disabled';
                throw new Error(`First-person rendering unavailable: ${reason}. Please install canvas + puppeteer-core, or provide an image URL/path.`);
            }
            return await this.agent.skills.viewer.capture();
        }

        // Already a base64 data URI
        if (source.startsWith('data:image/')) {
            return source;
        }

        // URL
        if (source.startsWith('http://') || source.startsWith('https://')) {
            const data = await this.download(source);
            const ext = this.guessExtension(source);
            return `data:image/${ext};base64,${data.toString('base64')}`;
        }

        // Local file path
        const fullPath = path.isAbsolute(source) ? source : path.join(process.cwd(), source);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${fullPath}`);
        }
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath).replace('.', '') || 'png';
        return `data:image/${ext};base64,${data.toString('base64')}`;
    }

    download(url) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https:') ? https : http;
            const req = client.get(url, { timeout: 15000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return this.download(res.headers.location).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Download timeout'));
            });
        });
    }

    guessExtension(url) {
        try {
            const parsed = new URL(url);
            const ext = path.extname(parsed.pathname).replace('.', '').toLowerCase();
            if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return ext;
        } catch (e) {}
        return 'png';
    }
}

module.exports = VisionSkill;
