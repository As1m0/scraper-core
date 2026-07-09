const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Shared Express harness: auth, /health, /shutdown, the /run-scrapers log-streaming
// route, and the runScrapers worker pool (run-mutex + per-task timeout enforcement,
// both from the 2026-07-08 operational fixes). Shop→scraper routing (buildTasks,
// shopToScraperKey, the scrapers array, cron scheduling) stays in each repo's
// main.js and is passed in.
const CORS_ORIGIN = 'https://perfect-store-online-ul.hu';

function isValidScraperKey(providedKey, trustedKey) {
    if (!providedKey || !trustedKey) return false;

    const providedBuffer = Buffer.from(String(providedKey));
    const trustedBuffer = Buffer.from(String(trustedKey));

    if (providedBuffer.length !== trustedBuffer.length) return false;

    return crypto.timingSafeEqual(providedBuffer, trustedBuffer);
}

function reqSafeString(value) {
    return typeof value === 'string' ? value : '';
}

function resolveTasksInput(query, shopToScraperKey, logCallback) {
    const shopParam = typeof query.shop === 'string' ? query.shop.trim() : '';
    if (shopParam !== '') {
        const taskKeys = shopParam
            .split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => Number.isInteger(id) && shopToScraperKey[id])
            .map(id => shopToScraperKey[id]);

        const uniqueTaskKeys = Array.from(new Set(taskKeys));

        if (uniqueTaskKeys.length === 0) {
            logCallback(`[WARN] No valid shops found in 'shop' query param: ${shopParam}`);
            return '';
        }

        return uniqueTaskKeys.join(',');
    }

    return reqSafeString(query.run) || 'all';
}

// Sweeps Puppeteer profile dirs orphaned by earlier crashes/restarts (no live
// browsers exist at boot, so anything left over is stale).
function sweepStaleProfiles(appDir) {
    try {
        const dataDir = path.join(appDir, 'data_collection');
        for (const entry of fs.readdirSync(dataDir)) {
            if (entry.startsWith('puppeteer_')) {
                fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') console.log(`[WARN] Stale profile sweep failed: ${err.message}`);
    }
}

function installProcessSafetyNet() {
    process.on('unhandledRejection', (err) => {
        console.error('[FATAL] Unhandled rejection:', err);
        process.exit(1);
    });
    process.on('uncaughtException', (err) => {
        console.error('[FATAL] Uncaught exception:', err);
        process.exit(1);
    });
}

// Retryable-error classification preserved verbatim from SEARCH's original
// runScrapers catch block. A "Task timeout after..." is a watchdog firing on a
// hung task, not a transient network blip, so it's excluded even though it
// contains the substring "timeout".
function isRetryableTaskError(err) {
    if (err.message.includes('Task timeout after')) return false;
    return (
        err.message.includes('ETXTBSY') ||
        err.code === 'ETXTBSY' ||
        err.message.includes('net::ERR_TUNNEL_CONNECTION_FAILED') ||
        err.message.includes('Navigation timeout') ||
        err.message.includes('timeout')
    );
}

// Builds the runScrapers(taskList, concurrency, logCallback) worker pool.
// One instance per server, so runInProgress is a true per-process mutex.
function createRunScrapers({ taskTimeoutMs, enableTransientRetry, afterAllTasks, restartAppOnSuccess }) {
    let runInProgress = false;

    return async function runScrapers(taskList = [], concurrency = Number(process.env.CONCURRENT_SCRAPES) || 4, logCallback = console.log) {
        if (runInProgress) {
            logCallback('[WARN] A scraper run is already in progress, skipping this trigger');
            return;
        }
        runInProgress = true;

        try {
            if (!taskList || taskList.length === 0) {
                logCallback('[WARN] No tasks provided');
                return;
            }

            logCallback(`[INFO] Running ${taskList.length} scraper tasks with concurrency ${concurrency}`);

            let idx = 0;
            const results = [];
            const timeoutMinutes = taskTimeoutMs / 1000 / 60;

            const worker = async () => {
                while (true) {
                    const i = idx++;
                    if (i >= taskList.length) break;

                    const task = taskList[i];

                    try {
                        logCallback(`[START] Starting ${task.name} scraper...`);

                        // Staggered start, before the timeout clock starts ticking
                        await new Promise(resolve => setTimeout(resolve, i * 3000 + Math.random() * 5000));

                        let timeoutId;
                        let timedOut = false;
                        const runPromise = task.scraper.run(logCallback);

                        try {
                            await Promise.race([
                                runPromise,
                                new Promise((_, reject) => {
                                    timeoutId = setTimeout(() => {
                                        timedOut = true;
                                        task.scraper.requestStop(`Task timeout after ${timeoutMinutes} minutes`);
                                        reject(new Error(`Task timeout after ${timeoutMinutes} minutes`));
                                    }, taskTimeoutMs);
                                })
                            ]);
                        } finally {
                            clearTimeout(timeoutId);
                            if (timedOut) {
                                // Wait (bounded) for the stopped run to settle so it can't
                                // keep a browser alive underneath this worker's next task.
                                // clearTimeout the loser explicitly - Promise.race leaves an
                                // otherwise-uncleared timer alive in the event loop for the
                                // full 60s even after the race settles via runPromise.
                                let settleTimeoutId;
                                await Promise.race([
                                    runPromise.catch(() => {}),
                                    new Promise(resolve => { settleTimeoutId = setTimeout(resolve, 60000); })
                                ]);
                                clearTimeout(settleTimeoutId);
                            }
                        }

                        logCallback(`[SUCCESS] ${task.name} scraper completed successfully`);
                        if (enableTransientRetry) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                        results.push({ task, success: true });

                    } catch (err) {
                        if (enableTransientRetry && err.message.includes('Task timeout after')) {
                            logCallback(`[ERROR] ${task.name} scraper timed out and was stopped: ${err.message}`);
                            results.push({ task, success: false, error: err });
                        } else if (enableTransientRetry && isRetryableTaskError(err)) {
                            logCallback(`[RETRY] ${task.name} scraper failed with ${err.message.substring(0, 100)}, retrying after delay...`);
                            const backoffDelay = Math.min(5000 * Math.pow(2, Math.random()), 30000);
                            await new Promise(resolve => setTimeout(resolve, backoffDelay));

                            try {
                                await task.scraper.run(logCallback);
                                logCallback(`[SUCCESS] ${task.name} scraper completed successfully on retry`);
                                results.push({ task, success: true, retried: true });
                            } catch (retryErr) {
                                logCallback(`[ERROR] ${task.name} scraper failed on retry: ${retryErr.message}`);
                                results.push({ task, success: false, error: retryErr });
                            }
                        } else {
                            logCallback(`[ERROR] ${task.name} scraper failed: ${err.message}`);
                            results.push({ task, success: false, error: err });
                        }
                    }
                }
            };

            await Promise.all(
                Array.from({ length: Math.min(concurrency, taskList.length) }, () => worker())
            );

            logCallback('[SUCCESS] All scrapers completed successfully');

            if (afterAllTasks) {
                await afterAllTasks(results, logCallback);
            }

            if (restartAppOnSuccess) {
                logCallback('[INFO] Restarting app to free memory...');
                process.exit(0); // Railway automatically restarts the container
            }
        } catch (err) {
            logCallback(`[ERROR] One or more scrapers failed: ${err.message}`);
        } finally {
            runInProgress = false;
        }
    };
}

// Builds the Express app + HTTP server shared by all three scrapers.
//
// Required options:
//   buildTasks(tasksInput, logCallback) -> Task[] | Promise<Task[]>
//     Task = { scraper, name, ...whatever the repo's scraper instances need }
//   shopToScraperKey: { [shopId]: taskKey }  -- drives ?shop= resolution
//
// Optional:
//   port                 default process.env.PORT || 3000
//   taskTimeoutMs         default process.env.TASK_TIMEOUT || 60min; read once at
//                          creation (matches: .env is loaded once at boot and never
//                          mutated at runtime in these repos)
//   outerTimeoutMs         SEARCH-only: wraps the /run-scrapers HTTP call (not cron)
//                          in a Promise.race, matching SEARCH's original SCRAPER_TIMEOUT
//   enableTransientRetry   SEARCH-only resilience profile: distinguishes a task-level
//                          timeout from a transient network error and retries the
//                          latter once after a backoff; also adds SEARCH's 1s
//                          post-success stagger. Off (false) preserves CONTENT/OOS's
//                          original log-and-continue behavior exactly.
//   afterAllTasks(results, logCallback)  -- aggregate API calls etc, run after the
//                          worker pool drains, before the RESTART_APP exit
//   restartAppOnSuccess    default process.env.RESTART_APP === 'true'
//   appDir                 default process.cwd(); base for the data_collection sweep
//
// Returns { app, server, runScrapers, resolveTasksInput }.
function createScraperServer(options = {}) {
    const {
        buildTasks,
        shopToScraperKey,
        port = process.env.PORT || 3000,
        taskTimeoutMs = Number(process.env.TASK_TIMEOUT) || 60 * 60 * 1000,
        outerTimeoutMs = null,
        enableTransientRetry = false,
        afterAllTasks = null,
        restartAppOnSuccess = process.env.RESTART_APP === 'true',
        appDir = process.cwd(),
    } = options;

    if (typeof buildTasks !== 'function') {
        throw new Error('createScraperServer requires a buildTasks(tasksInput, logCallback) function');
    }
    if (!shopToScraperKey) {
        throw new Error('createScraperServer requires a shopToScraperKey map');
    }

    installProcessSafetyNet();
    sweepStaleProfiles(appDir);

    const app = express();
    app.use(express.json());
    app.use(cors({ origin: CORS_ORIGIN }));

    // Health check must stay open for platform probes, so it's registered before auth
    app.get('/health', (req, res) => {
        res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    const SCRAPER_INBOUND_KEY = process.env.SCRAPER_INBOUND_KEY;
    app.use((req, res, next) => {
        if (!SCRAPER_INBOUND_KEY) {
            return res.status(503).json({ error: 'SCRAPER_INBOUND_KEY is not configured' });
        }

        // allow localhost bypass for testing
        if (process.env.NODE_ENV === 'development' && (req.ip === '::1' || req.ip === '127.0.0.1')) {
            return next();
        }

        const providedKey = req.headers['x-scraper-key'];
        if (!isValidScraperKey(providedKey, SCRAPER_INBOUND_KEY)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        next();
    });

    app.get('/shutdown', (req, res) => {
        res.status(200).json({ status: 'Shutting down...' });
        server.close(() => {
            console.log('[INFO] Server closed');
            process.exit(0);
        });
    });

    const runScrapers = createRunScrapers({ taskTimeoutMs, enableTransientRetry, afterAllTasks, restartAppOnSuccess });

    app.get('/run-scrapers', async (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const logCallback = (message) => {
            const timestamp = new Date().toISOString();
            res.write(`[${timestamp}] ${message}\n`);
            console.log(message);
        };

        try {
            logCallback('[INFO] Starting scrapers...');

            const tasksInput = resolveTasksInput(req.query, shopToScraperKey, logCallback);
            const dynamicTasks = await buildTasks(tasksInput, logCallback);
            const concurrency = Number(process.env.CONCURRENT_SCRAPES) || 4;

            if (outerTimeoutMs) {
                await Promise.race([
                    runScrapers(dynamicTasks, concurrency, logCallback),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Scrapers timeout after ${outerTimeoutMs / 1000 / 60} minutes`)), outerTimeoutMs)
                    )
                ]);
            } else {
                await runScrapers(dynamicTasks, concurrency, logCallback);
            }

            logCallback('[SUCCESS] All scrapers completed successfully');
        } catch (error) {
            logCallback(`[ERROR] Scraper execution failed: ${error.message}`);
        } finally {
            res.end();
        }
    });

    app.use((err, req, res, next) => {
        console.error('[ERROR] Unhandled error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });

    process.on('SIGTERM', () => {
        console.log('[INFO] Received SIGTERM, shutting down gracefully');
        server.close(() => {
            console.log('[INFO] Server closed');
            process.exit(0);
        });
    });

    const server = app.listen(port, '0.0.0.0', () => {
        console.log(`[SUCCESS] API running at http://localhost:${server.address().port}`);
    });

    return {
        app,
        server,
        runScrapers,
        resolveTasksInput: (query, logCallback) => resolveTasksInput(query, shopToScraperKey, logCallback),
    };
}

module.exports = { createScraperServer };
