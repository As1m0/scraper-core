// Node 18+ ships a global fetch; fall back to node-fetch only on older
// runtimes (consumers no longer need node-fetch as a dependency).
const fetch = globalThis.fetch
    ? (...args) => globalThis.fetch(...args)
    : (...args) => import('node-fetch').then(({ default: nodeFetch }) => nodeFetch(...args));

const DEFAULT_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
    return !Object.prototype.hasOwnProperty.call(error, 'status');
}

// A 2xx status doesn't guarantee a JSON body - shared hosts can serve an HTML
// holding/restart page (still 200) in front of the real app. Content-Type is
// enough to catch that without consuming the body, so the caller's own
// res.json()/res.text() still works untouched on the returned response.
function isJsonContentType(response) {
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json');
}

function getErrorMessage(error) {
    if (!error) {
        return 'Unknown error';
    }

    if (error.name === 'AbortError') {
        return 'Request aborted';
    }

    if (typeof error.message === 'string' && error.message.trim()) {
        return error.message;
    }

    if (error.cause && typeof error.cause.message === 'string' && error.cause.message.trim()) {
        return error.cause.message;
    }

    return String(error);
}

async function requestWithRetry(url, options = {}, config = {}) {
    const {
        timeoutMs = Number(process.env.API_TIMEOUT_MS) || 15000,
        maxRetries = Number(process.env.API_MAX_RETRIES) || 3,
        retryableStatusCodes = DEFAULT_RETRYABLE_STATUS_CODES,
        retryBaseDelayMs = Number(process.env.API_RETRY_BASE_DELAY_MS) || 500,
        retryOnTimeout = true,
        requestName = 'API request',
        expectJson = true
    } = config;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const attemptNumber = attempt + 1;
        const totalAttempts = maxRetries + 1;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });

            if (response.ok) {
                if (!expectJson || isJsonContentType(response)) {
                    clearTimeout(timeoutId);
                    return response;
                }

                const responseBody = await response.text();
                const contentType = response.headers.get('content-type');
                const error = new Error(`API returned ${response.status} with non-JSON content-type "${contentType}": ${responseBody.slice(0, 300)}`);
                error.status = response.status;

                if (attempt < maxRetries) {
                    clearTimeout(timeoutId);
                    const delayMs = retryBaseDelayMs * (2 ** attempt);
                    console.warn(`⚠️ ${requestName} attempt ${attemptNumber}/${totalAttempts} got non-JSON response (status ${response.status}, content-type ${contentType}). Retrying in ${delayMs}ms...`);
                    await sleep(delayMs);
                    continue;
                }

                clearTimeout(timeoutId);
                throw error; // caught below, which prefixes the message once
            }

            const responseBody = await response.text();
            const error = new Error(`API returned ${response.status}: ${responseBody}`);
            error.status = response.status;

            if (attempt < maxRetries && retryableStatusCodes.has(response.status)) {
                clearTimeout(timeoutId);
                const delayMs = retryBaseDelayMs * (2 ** attempt);
                console.warn(`⚠️ ${requestName} attempt ${attemptNumber}/${totalAttempts} failed with status ${response.status}. Retrying in ${delayMs}ms...`);
                await sleep(delayMs);
                continue;
            }

            clearTimeout(timeoutId);
            throw error; // caught below, which prefixes the message once
        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                if (attempt < maxRetries && retryOnTimeout) {
                    const delayMs = retryBaseDelayMs * (2 ** attempt);
                    console.warn(`⚠️ ${requestName} attempt ${attemptNumber}/${totalAttempts} timed out after ${timeoutMs}ms. Retrying in ${delayMs}ms...`);
                    await sleep(delayMs);
                    continue;
                }

                throw new Error(`${requestName} timed out after ${timeoutMs}ms on attempt ${attemptNumber}/${totalAttempts}`);
            }

            if (attempt < maxRetries && isRetryableError(error)) {
                const delayMs = retryBaseDelayMs * (2 ** attempt);
                console.warn(`⚠️ ${requestName} attempt ${attemptNumber}/${totalAttempts} failed (${getErrorMessage(error)}). Retrying in ${delayMs}ms...`);
                await sleep(delayMs);
                continue;
            }

            error.message = `${requestName} failed after ${attemptNumber}/${totalAttempts} attempts: ${getErrorMessage(error)}`;
            throw error;
        }
    }

    throw new Error('Request failed after all retry attempts');
}

module.exports = { requestWithRetry, DEFAULT_RETRYABLE_STATUS_CODES };
