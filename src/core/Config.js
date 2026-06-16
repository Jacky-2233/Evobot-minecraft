const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
    minecraft: {
        host: '127.0.0.1',
        port: 25565,
        username: 'EvoBot',
        version: '1.20.1',
        password: '',
        auth: 'offline',
    },
    ai: {
        apiKey: '',
        apiKeyFile: 'api_key_DO_NOT_DELETE.txt',
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        maxHistory: 20,
        replyTimeout: 15000,
        maxTokens: 200,
    },
    web: {
        enabled: true,
        port: 3000,
    },
    bot: {
        updateInterval: 300,
        statusInterval: 10000,
        reflectionInterval: 120000,
        autoReconnect: true,
        reconnectDelay: 5000,
        hungerThreshold: 16,
        lowHealthThreshold: 8,
        criticalHealthThreshold: 4,
        trashItems: ['dirt', 'cobblestone', 'gravel', 'sand', 'rotten_flesh'],
    },
    evolution: {
        enabled: true,
    },
};

function loadConfig(configPath = path.join(process.cwd(), 'config.json')) {
    let userConfig = {};
    if (fs.existsSync(configPath)) {
        try {
            userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.warn('[Config] Failed to parse config.json, using defaults:', e.message);
        }
    }

    const config = deepMerge(DEFAULT_CONFIG, userConfig);

    // Load API key from file if not set directly
    if (!config.ai.apiKey && config.ai.apiKeyFile) {
        const keyFile = path.join(process.cwd(), config.ai.apiKeyFile);
        if (fs.existsSync(keyFile)) {
            const content = fs.readFileSync(keyFile, 'utf8').trim();
            // Handle format like "NAME:MC_BOT_evobot\nKEY:sk-..."
            const keyMatch = content.match(/(?:KEY|key|api.?key)[=: ]+(sk-[\w]+)/);
            if (keyMatch) {
                config.ai.apiKey = keyMatch[1];
            } else {
                // Try to extract any sk- key
                const skMatch = content.match(/(sk-[\w]+)/);
                if (skMatch) config.ai.apiKey = skMatch[1];
            }
        }
    }

    // Environment overrides
    if (process.env.DEEPSEEK_API_KEY) config.ai.apiKey = process.env.DEEPSEEK_API_KEY;
    if (process.env.MC_HOST) config.minecraft.host = process.env.MC_HOST;
    if (process.env.MC_PORT) config.minecraft.port = parseInt(process.env.MC_PORT);
    if (process.env.MC_USERNAME) config.minecraft.username = process.env.MC_USERNAME;
    if (process.env.WEB_PORT) config.web.port = parseInt(process.env.WEB_PORT);

    return config;
}

function deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (!source || typeof source !== 'object') return output;
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            output[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            output[key] = source[key];
        }
    }
    return output;
}

function saveConfig(config, configPath = path.join(process.cwd(), 'config.json')) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = { loadConfig, saveConfig, DEFAULT_CONFIG };
