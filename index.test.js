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

    // init: uses the injected listProxies, builds host:port list, skips when useProxy is false
    const initScraper = new TestScraper(4, {
        scraperName: 'Init',
        listProxies: async () => [{ proxy_address: '1.1.1.1', port: 80 }, { bad: true }],
    });
    await initScraper.init();
    assert.deepStrictEqual(initScraper.proxyList, ['1.1.1.1:80'], 'init must build host:port list from valid entries');

    const noProxyScraper = new TestScraper(5, { scraperName: 'NoProxy', useProxy: false });
    await noProxyScraper.init(); // must not throw despite no listProxies injected
    assert.deepStrictEqual(noProxyScraper.proxyList, [], 'init with useProxy:false must skip the proxy fetch');

    // log/logPrefix: prefix override applies
    class PrefixScraper extends BaseScraper {
        logPrefix(level) { return `[X][${level}]`; }
    }
    const prefixLogs = [];
    const ps = new PrefixScraper(6, { scraperName: 'P' });
    ps.logCallback = (m) => prefixLogs.push(m);
    ps.log('hello');
    assert.strictEqual(prefixLogs[0], '[X][INFO] hello', 'log must use the logPrefix hook');

    // summaryEndpoint option wires the shared sendScrapeSummary
    const epScraper = new TestScraper(7, { scraperName: 'Ep', summaryEndpoint: '/scrapesummary/x' });
    assert.strictEqual(typeof epScraper.sendScrapeSummary, 'function', 'summaryEndpoint must produce a sender');
    assert.strictEqual(typeof epScraper.listProxies, 'function', 'listProxies must default to the shared implementation');

    // getBaseApiUrl: env override wins
    const { getBaseApiUrl } = require('./api');
    process.env.API_BASE_URL = 'http://example.test/api';
    assert.strictEqual(getBaseApiUrl(), 'http://example.test/api', 'API_BASE_URL env must override the default');
    delete process.env.API_BASE_URL;

    // ScrapeSummaryBase: envelope + hooks drive getSummary/getTextSummary
    const { ScrapeSummaryBase } = require('./scrapeSummaryBase');
    class TestSummary extends ScrapeSummaryBase {
        constructor(name, shopId) {
            super(name, shopId);
            this.totalProductsProcessed = 0;
            this.totalProductsFailed = 0;
        }
        addProductResults(processed, failed) {
            this.totalProductsProcessed += processed;
            this.totalProductsFailed += failed;
        }
        getCounters() {
            return { total_products_processed: this.totalProductsProcessed, total_products_failed: this.totalProductsFailed };
        }
        getStatsLines() { return [`Products Processed: ${this.totalProductsProcessed}`]; }
        getIssueLines() { return [`Failed Products: ${this.totalProductsFailed}`]; }
    }
    const summary = new TestSummary('T', 1);
    summary.start();
    summary.addProductResults(10, 1);
    summary.addRetry();
    summary.addError('boom');
    summary.addNote('n');
    summary.end();
    const data = summary.getSummary();
    assert.strictEqual(data.scraper_name, 'T');
    assert.strictEqual(data.shop_id, 1);
    assert.strictEqual(data.total_products_processed, 10, 'getCounters fields must appear in getSummary');
    assert.strictEqual(data.total_retries, 1);
    assert.strictEqual(data.success_rate, '90.00', 'default successRateInputs must use products processed/failed');
    assert.strictEqual(data.errors.length, 1);
    assert.strictEqual(data.notes.length, 1);
    assert.deepStrictEqual(
        Object.keys(data).slice(0, 5),
        ['scraper_name', 'shop_id', 'start_time', 'end_time', 'duration_seconds'],
        'envelope fields must precede counters');
    const empty = new TestSummary('E', 2);
    assert.strictEqual(empty.calculateSuccessRate(), 0, 'zero processed must yield 0, not NaN');
    summary.duration = 3723;
    assert.strictEqual(summary.formatDuration(), '1h 2m 3s');
    const text = summary.getTextSummary();
    assert.ok(text.includes('  • Products Processed: 10'), 'stats hook lines must render');
    assert.ok(text.includes('  • Success Rate: 90.00%'), 'success rate must be appended to stats');
    assert.ok(text.includes('  • Failed Products: 1'), 'issue hook lines must render');
    assert.ok(text.includes('  • Total Retries: 1') && text.includes('  • Errors Logged: 1'), 'shared issue lines must be appended');

    // createScraperServer: /health is open, /run-scrapers requires the key
    const { createScraperServer } = require('./server');
    process.env.SCRAPER_INBOUND_KEY = 'test-key';
    process.env.NODE_ENV = 'production'; // avoid the localhost auth-bypass path
    delete process.env.RESTART_APP;

    const httpInstance = createScraperServer({
        port: 0,
        buildTasks: async () => [],
        shopToScraperKey: { 1: 'fake' },
    });
    await new Promise(resolve => httpInstance.server.once('listening', resolve));
    const httpPort = httpInstance.server.address().port;
    const base = `http://127.0.0.1:${httpPort}`;

    const healthRes = await fetch(`${base}/health`);
    assert.strictEqual(healthRes.status, 200, '/health must be open without auth');

    const unauthedRes = await fetch(`${base}/run-scrapers?run=fake`);
    assert.strictEqual(unauthedRes.status, 401, '/run-scrapers must reject a missing key');

    // runScrapers mutex: a second call while the first is in flight is skipped,
    // not run concurrently (2026-07-08 operational fix)
    let releaseGate;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    let runCount = 0;
    const gatedScraper = {
        shopId: 1,
        requestStop() {},
        async run() { runCount++; await gate; return 'ok'; }
    };
    const mutexLogs = [];
    const firstRun = httpInstance.runScrapers([{ scraper: gatedScraper, name: 'Gated' }], 1, (m) => mutexLogs.push(m));
    await new Promise(resolve => setTimeout(resolve, 50));
    const secondLogs = [];
    await httpInstance.runScrapers([{ scraper: gatedScraper, name: 'Gated2' }], 1, (m) => secondLogs.push(m));
    assert.ok(secondLogs.some(m => m.includes('already in progress')), 'concurrent runScrapers call must be rejected by the mutex');
    releaseGate();
    await firstRun;
    assert.strictEqual(runCount, 1, 'exactly one task run must have started under the mutex');

    await new Promise(resolve => httpInstance.server.close(resolve));

    // Task timeout: requestStop() fires and the worker doesn't hang past the
    // stopped run settling (2026-07-08 operational fix)
    const timeoutInstance = createScraperServer({
        port: 0,
        buildTasks: async () => [],
        shopToScraperKey: { 1: 'fake' },
        taskTimeoutMs: 100,
    });
    await new Promise(resolve => timeoutInstance.server.once('listening', resolve));

    const hangingScraper = {
        shopId: 2,
        stopRequested: false,
        stopReason: null,
        requestStop(reason) { this.stopRequested = true; this.stopReason = reason; },
        async run() {
            while (!this.stopRequested) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error(this.stopReason);
        }
    };
    const timeoutLogs = [];
    await timeoutInstance.runScrapers([{ scraper: hangingScraper, name: 'Hanging' }], 1, (m) => timeoutLogs.push(m));
    assert.strictEqual(hangingScraper.stopRequested, true, 'requestStop must fire when a task exceeds taskTimeoutMs');
    assert.ok(timeoutLogs.some(m => m.includes('Task timeout after')), 'timeout must be logged');

    await new Promise(resolve => timeoutInstance.server.close(resolve));

    console.log('scraper-core self-check passed');
})();
