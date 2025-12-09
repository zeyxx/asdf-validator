import winston from 'winston';

const { combine, timestamp, printf, colorize, json } = winston.format;

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || 'info';

// Create the logger
export const logger = winston.createLogger({
  level: logLevel,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json()
  ),
  defaultMeta: { service: 'asdf-validator' },
  transports: [
    // Console transport with colors
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'HH:mm:ss' }),
        consoleFormat
      ),
    }),
  ],
});

// Add file transport if LOG_FILE is set
if (process.env.LOG_FILE) {
  logger.add(new winston.transports.File({
    filename: process.env.LOG_FILE,
    format: combine(
      timestamp(),
      json()
    ),
  }));
}

// Create child loggers for different components
export function createLogger(component: string): winston.Logger {
  return logger.child({ component });
}

// Structured log helpers
export interface LogContext {
  [key: string]: unknown;
}

export function logFee(
  logger: winston.Logger,
  amount: bigint,
  vault: 'BC' | 'AMM',
  mint?: string,
  symbol?: string
): void {
  logger.info('Fee detected', {
    event: 'fee',
    amount: amount.toString(),
    vault,
    mint,
    symbol,
  });
}

export function logBalanceChange(
  logger: winston.Logger,
  vault: 'BC' | 'AMM',
  oldBalance: bigint,
  newBalance: bigint
): void {
  logger.info('Balance changed', {
    event: 'balance_change',
    vault,
    oldBalance: oldBalance.toString(),
    newBalance: newBalance.toString(),
    delta: (newBalance - oldBalance).toString(),
  });
}

export function logConnection(
  logger: winston.Logger,
  type: 'websocket' | 'rpc',
  status: 'connected' | 'disconnected' | 'error',
  details?: string
): void {
  const level = status === 'error' ? 'error' : 'info';
  logger.log(level, `${type} ${status}`, {
    event: 'connection',
    connectionType: type,
    status,
    details,
  });
}

export function logRequest(
  logger: winston.Logger,
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  ip?: string
): void {
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  logger.log(level, `${method} ${path} ${statusCode}`, {
    event: 'http_request',
    method,
    path,
    statusCode,
    durationMs,
    ip,
  });
}

export default logger;
