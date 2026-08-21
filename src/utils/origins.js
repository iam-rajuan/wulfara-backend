const trimOrigin = (value) => (value ? value.replace(/\/+$/, '') : '');

const getConfiguredOrigins = () =>
  [process.env.WEBSITE_ORIGIN, process.env.DASHBOARD_ORIGIN]
    .flatMap((value) => (value || '').split(','))
    .map((value) => trimOrigin(value.trim()))
    .filter(Boolean);

const isOriginAllowed = (origin) => {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = trimOrigin(origin);
  const configuredOrigins = getConfiguredOrigins();

  if (configuredOrigins.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }

  return configuredOrigins.includes(normalizedOrigin);
};

const buildCorsOriginHandler = () => (origin, callback) => {
  if (isOriginAllowed(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS`));
};

const buildSocketCorsOptions = () => {
  const configuredOrigins = getConfiguredOrigins();

  return {
    origin:
      configuredOrigins.length > 0
        ? configuredOrigins
        : process.env.NODE_ENV === 'production'
          ? false
          : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  };
};

const getRequestOrigin = (req) => {
  const origin = req.get('origin');
  if (origin) {
    return trimOrigin(origin);
  }

  const referer = req.get('referer');
  if (referer) {
    try {
      return trimOrigin(new URL(referer).origin);
    } catch (error) {
      return '';
    }
  }

  return '';
};

const resolveAppOrigin = (req, preferredOrigin) => {
  const envOrigin = trimOrigin(preferredOrigin);
  if (envOrigin) {
    return envOrigin;
  }

  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin) {
    return requestOrigin;
  }

  if (process.env.NODE_ENV !== 'production') {
    return '';
  }

  return '';
};

module.exports = {
  buildCorsOriginHandler,
  buildSocketCorsOptions,
  getRequestOrigin,
  getConfiguredOrigins,
  isOriginAllowed,
  resolveAppOrigin,
  trimOrigin,
};
