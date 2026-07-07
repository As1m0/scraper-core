const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { isProxyError, shouldRestartBrowser } = require('./errorClassification');
const proxyQuarantine = require('./proxyQuarantine');
const proxyPool = require('./proxyPool');

// proxyQuarantine: save/load round trip (what seeds proxyPool's in-memory
// list on the next process boot in the same directory)
const tmpFile = path.join(os.tmpdir(), `proxy-quarantine-test-${process.pid}.json`);
assert.deepStrictEqual(proxyQuarantine.load(tmpFile), [], 'load must return [] when the file does not exist');
proxyQuarantine.save(['1.2.3.4'], tmpFile);
assert.deepStrictEqual(proxyQuarantine.load(tmpFile), ['1.2.3.4'], 'load must return what save wrote');
fs.unlinkSync(tmpFile);

// errorClassification
assert.strictEqual(isProxyError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED')), true);
assert.strictEqual(isProxyError(new Error('Some unrelated failure')), false);
assert.strictEqual(isProxyError(new Error('Unknown stock status'), ['Unknown stock status']), true);
assert.strictEqual(shouldRestartBrowser(new Error('Target closed')), true);
assert.strictEqual(shouldRestartBrowser(new Error('fine')), false);

// proxyPool: rotation avoids immediate repeats, quarantine removes a proxy from rotation
const proxies = ['p1', 'p2', 'p3'];
const seen = new Set();
for (let i = 0; i < 10; i++) {
    seen.add(proxyPool.getRandomProxy(proxies));
}
assert.ok(seen.size > 1, 'expected getRandomProxy to rotate across proxies');

proxyPool.quarantine('p1');
assert.strictEqual(proxyPool.isFailed('p1'), true);
for (let i = 0; i < 10; i++) {
    assert.notStrictEqual(proxyPool.getRandomProxy(proxies), 'p1', 'quarantined proxy must not be selected');
}

const lastUsed = proxyPool.getLastUsedProxy();
assert.strictEqual(proxyPool.popLastUsed(), lastUsed, 'popLastUsed must return the most recently used proxy');

console.log('scraper-core self-check passed');
