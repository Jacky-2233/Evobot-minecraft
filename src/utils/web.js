const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Simple web fetch utility (no external dependencies).
 * Returns raw text or html.
 */
function webfetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(url, { timeout: (options.timeout || 10) * 1000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, parsed).href;
                return webfetch(redirectUrl, options).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const text = buffer.toString('utf8');
                if (options.format === 'text') {
                    // Strip HTML tags and collapse whitespace
                    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    resolve(plain);
                } else {
                    resolve(text);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

module.exports = { webfetch };
