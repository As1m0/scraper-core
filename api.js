const { requestWithRetry } = require('./httpRetry');

// Env is read lazily inside each function (not at module load) so consumers'
// dotenv.config() timing doesn't matter.
function getBaseApiUrl() {
    return process.env.API_BASE_URL || (process.env.NODE_ENV === 'production'
        ? 'https://perfect-store-online-ul.hu/api'
        : 'http://localhost/perfect-store-online-ul/public_html/api');
}

// Every page of the account's list (it used to be page 1 of 50 only, so whatever
// Webshare sorted last — Hungarian proxies included — was never used).
// PROXY_COUNTRIES (e.g. "HU,AT,CZ,SK") narrows it: Alza answers IPs from outside
// its own markets with a Cloudflare 403.
async function listProxies() {
    const url = new URL('https://proxy.webshare.io/api/v2/proxy/list/');
    url.searchParams.append('mode', 'direct');
    url.searchParams.append('page_size', '100');
    if (process.env.PROXY_COUNTRIES) {
        url.searchParams.append('country_code__in', process.env.PROXY_COUNTRIES.replace(/\s/g, ''));
    }

    const proxies = [];
    // ponytail: 20-page cap (2,000 proxies) only guards against a `next` that never ends
    for (let next = url.href, page = 0; next && page < 20; page++) {
        const req = await requestWithRetry(next, {
            method: "GET",
            headers: {
                Authorization: process.env.PROXY_API_KEY
            }
        });
        const res = await req.json();
        proxies.push(...(res.results || []));
        next = res.next;
    }
    return proxies;
}

async function sendScrapeSummary(summaryData, endpointPath) {
    try {
        await requestWithRetry(getBaseApiUrl() + endpointPath, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'xapikey': process.env.API_KEY
            },
            body: JSON.stringify(summaryData)
        });

        console.log(`✅ Scrape summary sent successfully for ${summaryData.scraper_name}`);
        return { success: true };
    } catch (err) {
        console.error(`❌ Failed to send scrape summary: ${err.message}`);
        return { success: false, error: err.message };
    }
}

module.exports = { getBaseApiUrl, listProxies, sendScrapeSummary };
