const pino = require('pino');
const pinoHttp = require('pino-http');

const sensitiveKeys = new Set([
  'authorization',
  'cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'jwt',
  'secret',
  'apiKey',
  'apikey',
  'key',
]);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.token',
      'req.body.accessToken',
      'req.body.refreshToken',
      'req.body.secret',
      'req.body.apiKey',
    ],
    censor: '[redacted]',
  },
});

const sanitize = (value, depth = 0) => {
  if (depth > 3) {
    return '[truncated]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitize(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 20).map(([key, item]) => {
        const isSensitive = sensitiveKeys.has(key);
        const redactedValue = typeof item === 'string'
          ? `[redacted:length=${item.length}]`
          : '[redacted]';

        return [
          key,
          isSensitive ? redactedValue : sanitize(item, depth + 1),
        ];
      })
    );
  }

  if (typeof value === 'string' && value.length > 180) {
    return `${value.slice(0, 180)}...`;
  }

  return value;
};

const requestLogger = pinoHttp({
  logger,
  customProps: (req) => ({
    body: sanitize(req.body),
    query: sanitize(req.query),
    params: sanitize(req.params),
  }),
  customSuccessMessage: (req, res) => (
    `${req.method} ${req.originalUrl || req.url} completed with ${res.statusCode}`
  ),
  customErrorMessage: (req, res, error) => (
    `${req.method} ${req.originalUrl || req.url} failed with ${res.statusCode}: ${error.message}`
  ),
});

module.exports = {
  logger,
  requestLogger,
};
