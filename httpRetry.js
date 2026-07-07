const fetch = (...args) => import('node-fetch').then(({ default: nodeFetch }) => nodeFetch(...args));

const DEFAULT_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
    return !Object.prototype.hasOwnProperty.call(error, 'status');
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
        requestName = 'API request'
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
                clearTimeout(timeoutId);
                return response;
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
            error.message = `${requestName} failed after ${attemptNumber}/${totalAttempts} attempts: ${error.message}`;
            throw error;
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
