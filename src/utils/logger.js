const winston = require('winston');
const { format } = winston;
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
// Log level configurations with symbols and colors
const logConfig = {
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        http: 3,
        debug: 4
    },
    colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        http: 'magenta',
        debug: 'blue'
    },
};

// Add colors to Winston
winston.addColors(logConfig.colors);

// Custom format for better readability
const customFormat = format.printf(({ level, message, timestamp, ...metadata }) => {

    // Format the main message
    let msg = `${timestamp} [${level.toString()}]: ${message}`;

    // Add metadata if present (excluding internal winston properties)
    const cleanMetadata = { ...metadata };
    delete cleanMetadata.ms; // Remove winston internal timestamp diff
    delete cleanMetadata.service; // Remove service name if present

    if (Object.keys(cleanMetadata).length > 0) {
        // Special handling for error objects
        if (cleanMetadata.error) {
            const errorMeta = {
                error: {
                    message: cleanMetadata.error.message,
                    ...(cleanMetadata.error.stack ? { stack: cleanMetadata.error.stack } : {}),
                    ...(cleanMetadata.error.response ? {
                        status: cleanMetadata.error.response.status,
                        data: cleanMetadata.error.response.data
                    } : {})
                }
            };
            msg += '\n' + JSON.stringify(errorMeta, null, 2)
                .split('\n')
                .map(line => '    ' + line)
                .join('\n');
        } else {
            // Format other metadata
            msg += '\n' + JSON.stringify(cleanMetadata, null, 2)
                .split('\n')
                .map(line => '    ' + line)
                .join('\n');
        }
    }

    return msg;
});

// Create the logger instance with custom levels
const logger = winston.createLogger({
    levels: logConfig.levels,
    level: config.LOG_LEVEL, // Set to debug to show all logs
    format: format.combine(
        format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        format.errors({ stack: true }),
        format.splat(),
        format.colorize({ all: true }),
        customFormat
    ),
    transports: [
        new winston.transports.Console({
            handleExceptions: true,
            handleRejections: true,
        })
    ]
});

// Add file transports only if ENABLE_FILE_LOGS is set to true
if (config.ENABLE_FILE_LOGS === 'true') {
    // Ensure logs directory exists
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    logger.add(new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5,
    }));

    logger.add(new winston.transports.File({
        filename: 'logs/combined.log',
        maxsize: 5242880, // 5MB
        maxFiles: 5,
    }));
}

// Add a simple test log to verify logger is working
logger.info('Logger initialized');

// Export a wrapper with common logging methods and enhanced error handling
module.exports = {
    info: (message, meta = {}) => {
        logger.info(message, meta);
    },
    error: (message, error = null) => {
        const meta = error ? {
            error: {
                message: error.message,
                stack: error.stack,
                ...(error.response ? {
                    status: error.response.status,
                    data: error.response.data
                } : {})
            }
        } : {};
        logger.error(message, meta);
    },
    warn: (message, meta = {}) => {
        logger.warn(message, meta);
    },
    debug: (message, meta = {}) => {
        logger.debug(message, meta);
    },
    http: (message, meta = {}) => {
        logger.http(message, meta);
    }
}; 