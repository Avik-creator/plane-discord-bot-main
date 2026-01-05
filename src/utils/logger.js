/**
 * Simplified Logger for Cloudflare Workers
 * Avoids winston and other node-specific libraries that bloat worker size
 */

const formatMeta = (meta) => {
    if (!meta || Object.keys(meta).length === 0) return '';
    try {
        return '\n' + JSON.stringify(meta, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
            , 2);
    } catch (e) {
        return ' [Meta formatting error]';
    }
};

export default {
    info: (message, meta = {}) => {
        console.log(`[INFO] ${message}${formatMeta(meta)}`);
    },
    warn: (message, meta = {}) => {
        console.warn(`[WARN] ${message}${formatMeta(meta)}`);
    },
    error: (message, error = null) => {
        let meta = {};
        if (error instanceof Error) {
            meta = {
                message: error.message,
                stack: error.stack,
                ...(error.response ? { status: error.response.status, data: error.response.data } : {})
            };
        } else if (error) {
            meta = error;
        }
        console.error(`[ERROR] ${message}${formatMeta(meta)}`);
    },
    debug: (message, meta = {}) => {
        // In Workers, we only log debug if specifically needed, but we'll map to console.log
        console.log(`[DEBUG] ${message}${formatMeta(meta)}`);
    },
    http: (message, meta = {}) => {
        console.log(`[HTTP] ${message}${formatMeta(meta)}`);
    }
};
