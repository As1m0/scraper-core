const fs = require('fs');
const path = require('path');

function save(failedProxies, filePath = path.join(process.cwd(), 'proxy-quarantine.json')) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(failedProxies));
    } catch (err) {
        console.log(`[proxyQuarantine] Failed to persist: ${err.message}`);
    }
}

function load(filePath = path.join(process.cwd(), 'proxy-quarantine.json')) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

module.exports = { save, load };
