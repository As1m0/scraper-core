const { USER_AGENTS, uaLabel } = require('./userAgents');
const proxyQuarantine = require('./proxyQuarantine');
const proxyPool = require('./proxyPool');
const { isProxyError, shouldRestartBrowser, PROXY_ERROR_PATTERNS, BROWSER_RESTART_PATTERNS } = require('./errorClassification');
const { requestWithRetry, DEFAULT_RETRYABLE_STATUS_CODES } = require('./httpRetry');
const { BaseScraper, closeBrowserHard } = require('./baseScraper');
const { ScrapeSummaryBase } = require('./scrapeSummaryBase');
const { createScraperServer } = require('./server');
const { getBaseApiUrl, listProxies, sendScrapeSummary } = require('./api');

module.exports = {
    BaseScraper,
    closeBrowserHard,
    ScrapeSummaryBase,
    createScraperServer,
    getBaseApiUrl,
    listProxies,
    sendScrapeSummary,
    USER_AGENTS,
    uaLabel,
    proxyQuarantine,
    proxyPool,
    isProxyError,
    shouldRestartBrowser,
    PROXY_ERROR_PATTERNS,
    BROWSER_RESTART_PATTERNS,
    requestWithRetry,
    DEFAULT_RETRYABLE_STATUS_CODES,
};
