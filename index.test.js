const assert = require('assert');
const { isProxyError, shouldRestartBrowser } = require('./errorClassification');
const proxyPool = require('./proxyPool');

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
