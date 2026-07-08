const { requestWithRetry } = require('./httpRetry');

// Env is read lazily inside each function (not at module load) so consumers'
// dotenv.config() timing doesn't matter.
function getBaseApiUrl() {
    return process.env.API_BASE_URL || (process.env.NODE_ENV === 'production'
        ? 'https://perfect-store-online-ul.hu/api'
        : 'http://localhost/perfect-store-online-ul/public_html/api');
}

async function listProxies() {
    const url = new URL('https://proxy.webshare.io/api/v2/proxy/list/');
    url.searchParams.append('mode', 'direct');
    url.searchParams.append('page', '1');
    url.searchParams.append('page_size', '50');

    const req = await requestWithRetry(url.href, {
        method: "GET",
        headers: {
            Authorization: process.env.PROXY_API_KEY
        }
    });

    const res = await req.json();
    return res.results;
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
