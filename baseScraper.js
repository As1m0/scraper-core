const fs = require('fs');
const { USER_AGENTS } = require('./userAgents');
const proxyPool = require('./proxyPool');
const { isProxyError, shouldRestartBrowser } = require('./errorClassification');

// Shared browser-scraper base class. Holds only the methods verified identical
// across the OOS/CONTENT/SEARCH scrapers; browser launch and the run() loop
// stay in each consuming repo. Subclasses must provide log() and construct
// their own ScrapeSummary (metrics differ per scraper type).
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
}

module.exports = { BaseScraper };
