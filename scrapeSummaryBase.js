// Shared scaffolding for the per-repo ScrapeSummary classes.
//
// The envelope (scraper/shop identity, timing, retries, errors, notes) and the
// text-box rendering are identical across CONTENT/OOS/SEARCH; only the counter
// fields and their display lines differ. Subclasses supply those via hooks:
//
//   getCounters()        -> object spread into getSummary() between
//                           duration_seconds and total_retries
//   getStatsLines()      -> bullet lines for the 📊 STATISTICS section
//                           (Success Rate is appended automatically)
//   getIssueLines()      -> extra bullet lines for the ⚠️ ISSUES section
//                           (Total Retries / Errors Logged are appended)
//   successRateInputs()  -> { total, failed } for calculateSuccessRate();
//                           defaults to products processed/failed
class ScrapeSummaryBase {
    constructor(scraperName, shopId) {
        this.scraperName = scraperName;
        this.shopId = shopId;
        this.startTime = new Date();
        this.endTime = null;
        this.duration = null;
        this.totalRetries = 0;

        // Error tracking
        this.errors = [];
        this.maxErrorsToStore = 100;

        // Notes and additional info
        this.notes = [];
    }

    // Mark the start of scraping
    start() {
        this.startTime = new Date();
    }

    // Mark the end of scraping
    end() {
        this.endTime = new Date();
        this.duration = Math.round((this.endTime - this.startTime) / 1000); // Duration in seconds
    }

    // Add retry
    addRetry() {
        this.totalRetries++;
    }

    // Add error
    addError(errorMessage) {
        if (this.errors.length < this.maxErrorsToStore) {
            this.errors.push({
                timestamp: new Date().toISOString(),
                message: errorMessage
            });
        }
    }

    // Add note
    addNote(note) {
        this.notes.push({
            timestamp: new Date().toISOString(),
            message: note
        });
    }

    // --- Subclass hooks ---

    getCounters() {
        return {};
    }

    getStatsLines() {
        return [];
    }

    getIssueLines() {
        return [];
    }

    successRateInputs() {
        return { total: this.totalProductsProcessed || 0, failed: this.totalProductsFailed || 0 };
    }

    // --- Shared rendering ---

    // Calculate success rate
    calculateSuccessRate() {
        const { total, failed } = this.successRateInputs();
        if (total === 0) return 0;
        return (((total - failed) / total) * 100).toFixed(2);
    }

    // Get summary object
    getSummary() {
        return {
            scraper_name: this.scraperName,
            shop_id: this.shopId,
            start_time: this.startTime.toISOString(),
            end_time: this.endTime ? this.endTime.toISOString() : null,
            duration_seconds: this.duration,
            ...this.getCounters(),
            total_retries: this.totalRetries,
            success_rate: this.calculateSuccessRate(),
            errors: this.errors,
            notes: this.notes
        };
    }

    // Format duration for display
    formatDuration() {
        if (!this.duration) return 'N/A';

        const hours = Math.floor(this.duration / 3600);
        const minutes = Math.floor((this.duration % 3600) / 60);
        const seconds = this.duration % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    // Get a concise text summary
    getTextSummary() {
        const stats = [...this.getStatsLines(), `Success Rate: ${this.calculateSuccessRate()}%`];
        const issues = [...this.getIssueLines(), `Total Retries: ${this.totalRetries}`, `Errors Logged: ${this.errors.length}`];
        return `
╔════════════════════════════════════════════════════════════════╗
║                    SCRAPING SUMMARY                            ║
╚════════════════════════════════════════════════════════════════╝

Scraper: ${this.scraperName}
Shop ID: ${this.shopId}
Duration: ${this.formatDuration()}
Start: ${this.startTime.toLocaleString()}
End: ${this.endTime ? this.endTime.toLocaleString() : 'In Progress'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 STATISTICS:
${stats.map(line => `  • ${line}`).join('\n')}

⚠️  ISSUES:
${issues.map(line => `  • ${line}`).join('\n')}

╚════════════════════════════════════════════════════════════════╝
        `.trim();
    }
}

module.exports = { ScrapeSummaryBase };
