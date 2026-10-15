const proxyQuarantine = require('./proxyQuarantine');

// A connection/timeout failure is usually transient congestion: short, and global
// since the proxy itself is suspect. A bot-detection block (challenge, redirect loop)
// is one shop's verdict on the IP: long enough to outlast a run, but that shop only.
// ponytail: fixed TTLs; the env vars are the calibration knob until real block
// durations per shop are measured.
const QUARANTINE_TTL_MS = Number(process.env.PROXY_QUARANTINE_TTL_MS) || 15 * 60 * 1000;
const BLOCK_TTL_MS = Number(process.env.PROXY_BLOCK_TTL_MS) || 6 * 60 * 60 * 1000;
// A second timeout on the same shop within this window (i.e. right after the first
// quarantine expired) is that shop refusing the IP — Pelenka, and Alza by day, stall
// instead of serving a block page — so it escalates to a shop-scoped block.
const REPEAT_TIMEOUT_WINDOW_MS = 60 * 60 * 1000;

// Module-level (not global.*) state: still shared across every caller in the
// same process, since require() caches this module — same sharing behavior
// the old global.failedProxies/global.usedProxies gave each repo, without
// touching the global object.
// Seed from whatever the previous run in this same directory quarantined.
// key (proxy, or "shopId|proxy" for a shop-scoped block) -> expiresAt ms
let failedProxies = proxyQuarantine.load();
let usedProxies = [];
// "shopId|proxy" -> time of its last timeout quarantine.
// ponytail: in memory only — repeats that matter happen within one run; persist it if
// RESTART_APP ever restarts mid-run.
const lastTimeoutAt = new Map();

const blockKey = (shopId, proxy) => `${shopId}|${proxy}`;

// Expired entries are deleted as they are read; no timers.
function isActive(key) {
    const expiresAt = failedProxies.get(key);
    if (expiresAt === undefined) {
        return false;
    }
    if (expiresAt > Date.now()) {
        return true;
    }
    failedProxies.delete(key);
    return false;
}

function isFailed(proxy, shopId) {
    return isActive(proxy) || (shopId != null && isActive(blockKey(shopId, proxy)));
}

function formatTtl(ms) {
    return ms >= 60 * 60 * 1000 ? `${+(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}m`;
}

// ponytail: no lock around the read-then-write below, so two concurrent
// workers can both see a proxy as available in the gap. Matches prior
// behavior; add a lock if double-use starts causing real problems.
function getRandomProxy(proxyList, log = () => {}, shopId) {
    let healthyProxies = proxyList.filter(proxy => !isFailed(proxy, shopId));
    if (healthyProxies.length === 0) {
        log('⚠️ All proxies are quarantined, resetting proxy pool and retrying.', 'WARN');
        // Only what blocks this shop is cleared; other shops' blocks stand.
        for (const proxy of proxyList) {
            failedProxies.delete(proxy);
            if (shopId != null) {
                failedProxies.delete(blockKey(shopId, proxy));
            }
        }
        usedProxies = [];
        proxyQuarantine.save(failedProxies);
        healthyProxies = proxyList.slice();
    }

    if (healthyProxies.length === 0) {
        throw new Error('No proxies available for rotation.');
    }

    if (usedProxies.length >= healthyProxies.length) {
        usedProxies = [];
    }

    const availableProxies = healthyProxies.filter(proxy => !usedProxies.includes(proxy));

    let selectedProxy;
    if (availableProxies.length === 0) {
        usedProxies = [];
        selectedProxy = healthyProxies[Math.floor(Math.random() * healthyProxies.length)];
    } else {
        selectedProxy = availableProxies[Math.floor(Math.random() * availableProxies.length)];
    }

    usedProxies.push(selectedProxy);
    if (usedProxies.length > 5) {
        usedProxies.shift();
    }

    return selectedProxy;
}

// blocked: the shop's bot detection rejected this IP (scoped to shopId when given).
// A timeout with a shopId counts a strike only while the proxy is out of quarantine, so
// one failure reported twice (or by two workers at once) never escalates itself.
function quarantine(proxy, log = () => {}, { shopId, blocked = false } = {}) {
    if (!proxy) {
        return;
    }
    let repeat = false;
    if (!blocked) {
        if (isFailed(proxy, shopId)) {
            return;
        }
        if (shopId != null) {
            const strikeKey = blockKey(shopId, proxy);
            const previous = lastTimeoutAt.get(strikeKey);
            repeat = previous !== undefined && Date.now() - previous <= REPEAT_TIMEOUT_WINDOW_MS;
            lastTimeoutAt.set(strikeKey, Date.now());
        }
    }
    const scoped = (blocked || repeat) && shopId != null;
    const key = scoped ? blockKey(shopId, proxy) : proxy;
    if (isActive(key)) {
        return;
    }
    const ttl = blocked || repeat ? BLOCK_TTL_MS : QUARANTINE_TTL_MS;
    failedProxies.set(key, Date.now() + ttl);
    proxyQuarantine.save(failedProxies);
    log(`⛔ Quarantined proxy: ${proxy} for ${formatTtl(ttl)}${scoped ? ` on shop ${shopId}` : ''}${repeat ? ' (repeat timeout)' : ''}`);
}

function getLastUsedProxy() {
    return usedProxies[usedProxies.length - 1];
}

function popLastUsed() {
    return usedProxies.pop();
}

module.exports = { getRandomProxy, quarantine, getLastUsedProxy, popLastUsed, isFailed };
