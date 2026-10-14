const fs = require('fs');
const path = require('path');

// Persists proxyPool's quarantine as { key: expiresAt } (key = proxy, or
// "shopId|proxy" for a shop-scoped block).
function save(failedProxies, filePath = path.join(process.cwd(), 'proxy-quarantine.json')) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(failedProxies)));
    } catch (err) {
        console.log(`[proxyQuarantine] Failed to persist: ${err.message}`);
    }
}

// Expired entries are dropped. A pre-v1.12 file (plain array, no expiry) is
// ignored rather than trusted forever.
function load(filePath = path.join(process.cwd(), 'proxy-quarantine.json')) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return new Map();
        }
        const now = Date.now();
        return new Map(Object.entries(parsed).filter(([, expiresAt]) => Number(expiresAt) > now));
    } catch (err) {
        return new Map();
    }
}

module.exports = { save, load };
