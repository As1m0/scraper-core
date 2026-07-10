const fs = require('fs');
const { USER_AGENTS } = require('./userAgents');
const proxyPool = require('./proxyPool');
const { isProxyError, shouldRestartBrowser } = require('./errorClassification');
const api = require('./api');

// Shared browser-scraper base class. Holds only the methods verified identical
// across the OOS/CONTENT/SEARCH scrapers; the run() loop stays in each
// consuming repo. Subclasses must provide log() and construct their own
// ScrapeSummary (metrics differ per scraper type).
//
// setupPage()/getBrowserArgs()/shouldBlockRequest()/getExtraHeaders()/cleanup()
// match CONTENT/OOS's browser setup exactly (proven byte-identical). The
// puppeteer.launch() call itself stays per-repo — core never requires
// puppeteer, it only operates on the browser/page objects handed to it, so
// consumers keep sole ownership of that dependency and its Chromium binary.
// SEARCH's setup diverges (anti-detection script, no disconnected handler,
// @sparticuz/chromium) and keeps its own full override; it does not use these.
//
// openBrowserWithRecovery() retries the initial pre-loop launch (proxy
// quarantine + backoff + final no-proxy fallback). Only CONTENT calls it
// today. SEARCH does not use it and should not: its own run() loop already
// wraps proxy-selection + openBrowser() + the scrape as one retryable unit
// with sticky-proxy semantics, so layering this underneath would nest two
// retry loops and add a no-proxy fallback SEARCH's design doesn't have.
class BaseScraper {
    constructor(shopId, options = {}) {
        this.shopId = shopId;
        this.scraperName = options.scraperName || `Scraper-${shopId}`;
        this.debug = options.debug ?? false;
        this.useProxy = options.useProxy ?? true;
        this.proxyList = [];
        this.proxies = [];
        this.logCallback = null;
        this.uniqueFolderPath = "";
        this.currentProxy = null;
        this.stopRequested = false;
        this.stopReason = null;

        // Per-repo error strings layered onto the shared restart-trigger list.
        this.extraRestartPatterns = options.extraRestartPatterns ?? [];

        // Bounds for getRandomWaitTime(); each repo passes its own defaults.
        this.minWaitMs = options.minWaitMs ?? 2000;
        this.maxWaitMs = options.maxWaitMs ?? 5000;

        // Backend API functions: repos may inject their own, otherwise the
        // shared implementations are used. summaryEndpoint names the per-repo
        // scrape-summary path (e.g. '/scrapesummary/scrape-summary-oos').
        this.listProxies = options.listProxies ?? api.listProxies;
        this.sendScrapeSummary = options.sendScrapeSummary
            ?? (options.summaryEndpoint ? (data) => api.sendScrapeSummary(data, options.summaryEndpoint) : null);
    }

    logPrefix(level) {
        return `[${this.scraperName}][${level}]`;
    }

    log(message, level = 'INFO') {
        try {
            const logMessage = `${this.logPrefix(level)} ${message}`;

            if (this.logCallback) {
                this.logCallback(logMessage);
            } else {
                console.log(logMessage);
            }
        } catch (logErr) {
            console.error('Error in log method:', logErr.message);
            console.log(message); // Fallback
        }
    }

    async init() {
        this.log(`🛒 Initializing scraper for shopId ${this.shopId}`);

        if (this.useProxy) {
            this.proxies = await this.listProxies();
            if (!this.proxies?.length) throw new Error('No proxies retrieved from API.');

            this.proxyList = this.proxies
                .filter(p => p?.proxy_address && p?.port)
                .map(p => `${p.proxy_address}:${p.port}`);

            this.log(`Fetched ${this.proxyList.length} proxies.`);
        }
    }

    async detectChallengePage(page) {
        try {
            if (!page || page.isClosed()) {
                return { isChallenge: false, reason: null };
            }

            const challengeSignals = await page.evaluate(() => {
                const lower = (value) => (value || '').toLowerCase();
                const bodyText = lower(document.body ? document.body.innerText : '');
                const titleText = lower(document.title || '');

                const hasTurnstileScript = !!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
                const hasTurnstileWidget = !!document.querySelector('.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"]');

                const keywords = [
                    'verify you are human',
                    'just a moment',
                    'checking your browser',
                    'cloudflare',
                    'captcha',
                    'hús-vér ember',
                    'erositsd meg',
                    'erősítsd meg'
                ];

                const matchedKeyword = keywords.find((keyword) =>
                    bodyText.includes(keyword) || titleText.includes(keyword)
                ) || null;

                return {
                    hasTurnstileScript,
                    hasTurnstileWidget,
                    matchedKeyword,
                    titleText
                };
            });

            const url = (page.url() || '').toLowerCase();
            const urlLooksLikeChallenge =
                url.includes('/cdn-cgi/challenge') ||
                url.includes('cf_chl') ||
                url.includes('challenge-platform');

            if (
                urlLooksLikeChallenge ||
                challengeSignals.hasTurnstileScript ||
                challengeSignals.hasTurnstileWidget ||
                !!challengeSignals.matchedKeyword
            ) {
                const reason =
                    challengeSignals.matchedKeyword ||
                    (challengeSignals.hasTurnstileScript || challengeSignals.hasTurnstileWidget ? 'cloudflare_turnstile_detected' : 'challenge_url_pattern');

                return { isChallenge: true, reason };
            }

            return { isChallenge: false, reason: null };
        } catch (err) {
            this.log(`Challenge detection check failed: ${err.message}`, 'WARN');
            return { isChallenge: false, reason: null };
        }
    }

    async cleanupFolder() {
        if (this.uniqueFolderPath && fs.existsSync(this.uniqueFolderPath)) {
            try {
                // Force recursive removal with retry logic
                await this.removeDirectoryWithRetry(this.uniqueFolderPath, 3);
            } catch (err) {
                this.log(`⚠️ Failed to clean up folder ${this.uniqueFolderPath}: ${err.message}`, 'WARN');
                // Don't throw - cleanup failure shouldn't stop the scraper
            }
        }
    }

    async removeDirectoryWithRetry(dirPath, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Force remove with all options
                fs.rmSync(dirPath, {
                    recursive: true,
                    force: true,
                    maxRetries: 3,
                    retryDelay: 100
                });
                return; // Success
            } catch (err) {
                if (attempt === maxRetries) {
                    this.log(`⚠️ Final attempt to remove directory failed: ${err.message}`, 'WARN');
                }
                // Wait before retry
                await new Promise(res => setTimeout(res, 200 * attempt));
            }
        }
    }

    requestStop(reason = 'Stop requested') {
        if (this.stopRequested) {
            return;
        }

        this.stopRequested = true;
        this.stopReason = reason;
        this.log(`🛑 ${reason}`, 'WARN');

        const browser = this.activeBrowser;
        if (browser) {
            this.intentionalBrowserClose = true;
            Promise.resolve(browser.close()).catch((err) => {
                this.log(`⚠️ Failed to close browser during stop: ${err.message}`, 'WARN');
            });
        }
    }

    throwIfStopRequested() {
        if (this.stopRequested) {
            throw new Error(this.stopReason || 'Scraper stopped');
        }
    }

    quarantineCurrentProxy(reason = 'proxy quarantine') {
        if (!this.currentProxy) {
            return;
        }

        proxyPool.quarantine(this.currentProxy, (msg) => this.log(`${msg} (${reason})`, 'WARN'));

        // Repos clear their own active-proxy field (activeProductProxy /
        // activeKeywordProxy) via this hook.
        this.onProxyQuarantined?.(this.currentProxy);
    }

    getRandomProxy() {
        return proxyPool.getRandomProxy(this.proxyList, (msg, level) => this.log(msg, level));
    }

    getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    getRandomWaitTime(min = this.minWaitMs, max = this.maxWaitMs) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    isProxyError(err) {
        const isProxyFail = isProxyError(err);

        // Mark the current proxy as failed if it's a proxy-related error
        if (isProxyFail) {
            const lastProxy = proxyPool.getLastUsedProxy();
            if (lastProxy) {
                proxyPool.quarantine(lastProxy, (msg) => this.log(`🚫 Marked proxy as failed: ${lastProxy}`));
            }
        }

        return isProxyFail;
    }

    shouldRestartBrowser(err) {
        return shouldRestartBrowser(err, this.extraRestartPatterns);
    }

    // Default Chromium launch args; override to add/remove flags (e.g. OOS's
    // --disable-images/-extensions/-plugins).
    getBrowserArgs(proxyServer) {
        return [
            this.useProxy ? `--proxy-server=${proxyServer}` : '',
            '--lang=hu-HU,hu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--single-process',
            '--no-zygote'
        ];
    }

    // Default request-blocking policy; override to add per-repo rules.
    shouldBlockRequest(req) {
        const url = req.url();
        const resourceType = req.resourceType();

        return (
            url.includes('cloudflareinsights') ||
            url.includes('speedcurve') ||
            url.includes('googletagmanager') ||
            url.includes('google-analytics') ||
            url.includes('facebook.com/tr') ||
            (resourceType === 'media') ||
            url.includes('/ads/') ||
            url.includes('doubleclick')
        );
    }

    // Default outbound headers; override to change per-repo.
    getExtraHeaders() {
        return {
            'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Keep-Alive': 'timeout=60, max=1000'
        };
    }

    // Wires a freshly-launched browser's page: error/disconnected handlers,
    // request interception via shouldBlockRequest(), proxy auth, timezone,
    // UA/viewport randomization, headers, and debug console logging. Callers
    // do `const page = await this.setupPage(browser);` after puppeteer.launch().
    async setupPage(browser) {
        const page = await browser.newPage();

        page.on('error', (err) => {
            this.log(`⚠️ Page error event: ${err.message}`, 'WARN');
        });

        browser.on('disconnected', () => {
            if (!this.intentionalBrowserClose) {
                this.log('⚠️ Browser CDP connection lost unexpectedly', 'WARN');
                this.browserDisconnected = true;
            }
        });

        if (!this.debug) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                try {
                    if (this.shouldBlockRequest(req)) {
                        req.abort();
                    } else {
                        req.continue();
                    }
                } catch (err) {
                    try {
                        req.continue();
                    } catch (continueErr) {
                        this.log(`Request handling error: ${err.message}`, 'WARN');
                    }
                }
            });
        }

        if (this.useProxy) {
            const selectedProxy = this.proxies.find(
                p => `${p.proxy_address}:${p.port}` === this.currentProxy
            ) || this.proxies[0];

            await page.authenticate({
                username: selectedProxy.username,
                password: selectedProxy.password
            });
        }

        await page.emulateTimezone('Europe/Budapest');

        const userAgent = this.getRandomUserAgent();
        await page.setUserAgent(userAgent);
        await page.setViewport({
            width: 1200 + Math.floor(Math.random() * 200),
            height: 700 + Math.floor(Math.random() * 100)
        });

        await page.setExtraHTTPHeaders(this.getExtraHeaders());

        if (this.debug) {
            page.on('console', msg => {
                this.log(`🖥️ Browser console message: ${msg.text()}`);
            });
        }

        return page;
    }

    // Retries the initial browser launch (before any product/keyword loop
    // starts) up to maxAttempts times: quarantines the proxy on a timeout-like
    // or proxy-classified failure, closes any partial page/browser, cleans up,
    // and backs off 1500ms * attempt between tries. The final attempt disables
    // useProxy entirely as a last resort. Depends only on this.openBrowser()
    // (per-repo override) and already-shared primitives, so it's launch-only —
    // no product/batch state coupling.
    async openBrowserWithRecovery(preferredProxy = null, maxAttempts = 3) {
        let lastError;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this.throwIfStopRequested();

            const isFinalAttempt = attempt === maxAttempts;
            const disableProxyForFinalAttempt = this.useProxy && isFinalAttempt;
            const proxyForAttempt = attempt === 1 ? preferredProxy : null;

            if (disableProxyForFinalAttempt) {
                this.log('🔄 Final browser launch attempt without proxy...', 'WARN');
                this.useProxy = false;
            }

            try {
                const result = await this.openBrowser(proxyForAttempt);
                this.intentionalBrowserClose = false;
                this.browserDisconnected = false;
                return result;
            } catch (err) {
                lastError = err;
                const message = err?.message || '';
                const timeoutLikeError = /timed out|timeout/i.test(message);

                if (this.currentProxy && (timeoutLikeError || this.isProxyError(err))) {
                    this.quarantineCurrentProxy(timeoutLikeError ? 'browser launch timeout' : 'browser launch connection error');
                    proxyPool.popLastUsed();
                }

                this.log(`⚠️ Browser launch attempt ${attempt}/${maxAttempts} failed: ${message}`, 'WARN');

                this.intentionalBrowserClose = true;
                try {
                    if (this.activePage && !this.activePage.isClosed()) {
                        await this.activePage.removeAllListeners();
                        await this.activePage.close();
                    }
                } catch (pageErr) {
                    this.log(`⚠️ Failed to close page after launch error: ${pageErr.message}`, 'WARN');
                }

                try {
                    if (this.activeBrowser && this.activeBrowser.connected) {
                        await Promise.race([
                            this.activeBrowser.close(),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Browser close timeout')), 5000)
                            )
                        ]);
                    }
                } catch (closeErr) {
                    this.log(`⚠️ Failed to close browser after launch error: ${closeErr.message}`, 'WARN');
                }

                this.activeBrowser = null;
                this.activePage = null;
                await this.cleanup();
                this.intentionalBrowserClose = false;
                this.browserDisconnected = false;

                if (!isFinalAttempt) {
                    await new Promise(res => setTimeout(res, 1500 * attempt));
                }
            } finally {
                if (disableProxyForFinalAttempt) {
                    this.useProxy = true;
                }
            }
        }

        throw lastError || new Error('Browser launch failed after retries');
    }

    // Default cleanup hook the run() loop calls between/after browsers.
    async cleanup() {
        return this.cleanupFolder();
    }

    // Send summary to API
    async sendSummary() {
        try {
            if (!this.sendScrapeSummary) {
                this.log('⚠️ No sendScrapeSummary function injected; skipping summary send', 'WARN');
                return;
            }

            const summaryData = this.summary.getSummary();
            const result = await this.sendScrapeSummary(summaryData);

            if (result.success) {
                this.log('📊 Summary sent to API successfully');
            } else {
                this.log(`⚠️ Failed to send summary to API: ${result.error}`, 'WARN');
            }
        } catch (error) {
            this.log(`⚠️ Error sending summary: ${error.message}`, 'WARN');
            // Don't throw - summary failure shouldn't stop the scraper
        }
    }
}

module.exports = { BaseScraper };
