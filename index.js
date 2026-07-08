const { USER_AGENTS } = require('./userAgents');
const proxyQuarantine = require('./proxyQuarantine');
const proxyPool = require('./proxyPool');
const { isProxyError, shouldRestartBrowser, PROXY_ERROR_PATTERNS, BROWSER_RESTART_PATTERNS } = require('./errorClassification');
const { requestWithRetry, DEFAULT_RETRYABLE_STATUS_CODES } = require('./httpRetry');
const { BaseScraper } = require('./baseScraper');
const { getBaseApiUrl, listProxies, sendScrapeSummary } = require('./api');

module.exports = {
    BaseScraper,
    getBaseApiUrl,
    listProxies,
    sendScrapeSummary,
    USER_AGENTS,
    proxyQuarantine,
    proxyPool,
    isProxyError,
    shouldRestartBrowser,
    PROXY_ERROR_PATTERNS,
    BROWSER_RESTART_PATTERNS,
    requestWithRetry,
    DEFAULT_RETRYABLE_STATUS_CODES,
};
