const PROXY_ERROR_PATTERNS = [
    'ERR_PROXY',
    'ERR_TUNNEL',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_TIMED_OUT',
    'ECONNRESET',
    'EPIPE',
    'socket hang up',
    'net::ERR_CONNECTION_RESET',
];

const BROWSER_RESTART_PATTERNS = [
    'detached Frame',
    'Protocol',
    'Target closed',
    'socket hang up',
    'Socket connection failed',
    'Waiting for selector',
    'Proxy connection failed',
    'Navigation timeout',
    'timeout - restart browser',
    'ECONNRESET',
    'EPIPE',
    'Browser restart required',
    'Execution context was destroyed',
    'Encountered CAPTCHA page',
    'Page became closed',
    'Connection closed',
    'Navigating frame was detached',
];

// extraPatterns lets a repo add its own scraper-specific strings (e.g. OOS's
// "Unknown stock status") without forking the shared list.
function isProxyError(err, extraPatterns = []) {
    const message = err?.message || '';
    return PROXY_ERROR_PATTERNS.concat(extraPatterns).some(pattern => message.includes(pattern));
}

function shouldRestartBrowser(err, extraPatterns = []) {
    const message = err?.message || '';
    return BROWSER_RESTART_PATTERNS.concat(extraPatterns).some(pattern => message.includes(pattern));
}

// A child process that never started (e.g. 'spawn /tmp/chromium EAGAIN' when the container is out of processes).
// Puppeteer's pipe launch has already rejected ("Target closed") and dropped its listeners by the time this error
// arrives, so it surfaces as uncaught; the scraper retries the launch, so it must not end the whole run.
function isChildSpawnFailure(err) {
    return typeof err?.syscall === 'string' && err.syscall.startsWith('spawn');
}

module.exports = { isProxyError, shouldRestartBrowser, isChildSpawnFailure, PROXY_ERROR_PATTERNS, BROWSER_RESTART_PATTERNS };
