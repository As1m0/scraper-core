const fs = require('fs');
const path = require('path');

// ponytail: write-only log today (nothing reads it back on boot) — kept as-is
// from the original per-repo copies; fixing that is a separate change.
function save(failedProxies, filePath = path.join(process.cwd(), 'proxy-quarantine.json')) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(failedProxies));
    } catch (err) {
        console.log(`[proxyQuarantine] Failed to persist: ${err.message}`);
    }
}

module.exports = { save };
