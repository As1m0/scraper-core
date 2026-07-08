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

// BaseScraper: constructor defaults, per-repo overrides, quarantine hook
const { BaseScraper } = require('./baseScraper');
const logs = [];
class TestScraper extends BaseScraper {
    log(message, level = 'INFO') { logs.push(message); }
    onProxyQuarantined(proxy) { this.clearedProxy = proxy; }
}
const scraper = new TestScraper(1, {
    scraperName: 'Test',
    extraRestartPatterns: ['My custom failure'],
    minWaitMs: 100,
    maxWaitMs: 200,
});
assert.strictEqual(scraper.useProxy, true, 'useProxy must default to true');
assert.strictEqual(scraper.shouldRestartBrowser(new Error('Target closed')), true, 'shared restart patterns must apply');
assert.strictEqual(scraper.shouldRestartBrowser(new Error('My custom failure')), true, 'extraRestartPatterns must layer on top');
assert.strictEqual(scraper.shouldRestartBrowser(new Error('fine')), false);
const wait = scraper.getRandomWaitTime();
assert.ok(wait >= 100 && wait <= 200, 'getRandomWaitTime must respect constructor bounds');
scraper.currentProxy = 'p9';
scraper.quarantineCurrentProxy('test');
assert.strictEqual(proxyPool.isFailed('p9'), true, 'quarantineCurrentProxy must quarantine the current proxy');
assert.strictEqual(scraper.clearedProxy, 'p9', 'onProxyQuarantined hook must fire with the quarantined proxy');
scraper.requestStop('test stop');
assert.throws(() => scraper.throwIfStopRequested(), /test stop/, 'throwIfStopRequested must throw the stop reason');

// sendSummary: uses the injected sender; no-throw + warn when none injected
(async () => {
    let sent = null;
    const sender = new TestScraper(2, {
        scraperName: 'Sender',
        sendScrapeSummary: async (data) => { sent = data; return { success: true }; },
    });
    sender.summary = { getSummary: () => ({ ok: 1 }) };
    await sender.sendSummary();
    assert.deepStrictEqual(sent, { ok: 1 }, 'sendSummary must post summary via the injected function');

    const noSender = new TestScraper(3, { scraperName: 'NoSender' });
    noSender.summary = { getSummary: () => ({}) };
    await noSender.sendSummary(); // must not throw

    console.log('scraper-core self-check passed');
})();
