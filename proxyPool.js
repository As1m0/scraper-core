const proxyQuarantine = require('./proxyQuarantine');

// Module-level (not global.*) state: still shared across every caller in the
// same process, since require() caches this module — same sharing behavior
// the old global.failedProxies/global.usedProxies gave each repo, without
// touching the global object.
let failedProxies = [];
let usedProxies = [];

// ponytail: no lock around the read-then-write below, so two concurrent
// workers can both see a proxy as available in the gap. Matches prior
// behavior; add a lock if double-use starts causing real problems.
function getRandomProxy(proxyList, log = () => {}) {
    let healthyProxies = proxyList.filter(proxy => !failedProxies.includes(proxy));
    if (healthyProxies.length === 0) {
        log('⚠️ All proxies are quarantined, resetting proxy pool and retrying.', 'WARN');
        failedProxies = [];
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

function quarantine(proxy, log = () => {}) {
    if (!proxy || failedProxies.includes(proxy)) {
        return;
    }
    failedProxies.push(proxy);
    proxyQuarantine.save(failedProxies);
    log(`⛔ Quarantined proxy: ${proxy}`);
}

function getLastUsedProxy() {
    return usedProxies[usedProxies.length - 1];
}

function popLastUsed() {
    return usedProxies.pop();
}

function isFailed(proxy) {
    return failedProxies.includes(proxy);
}

module.exports = { getRandomProxy, quarantine, getLastUsedProxy, popLastUsed, isFailed };
