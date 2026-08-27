const trimOrigin = (value) => (value ? value.replace(/\/+$/, '') : '');

const STATIC_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:5000',
  'http://localhost:5173',
  'https://wulfara-dashboard-woad.vercel.app',
  'https://wulfara-website-seven.vercel.app',
  'https://wulfara-backend.onrender.com',
  'https://wulfara.space',
  'https://www.wulfara.space',
  'https://admin.wulfara.space',
  'https://api.wulfara.space',
];

const isWulfaraSubdomain = (origin) => {
  try {
    const host = new URL(origin).hostname;
    return host.endsWith('.wulfara.space');
  } catch (error) {
    return false;
  }
};

const getConfiguredOrigins = () => STATIC_ALLOWED_ORIGINS.slice();

const isOriginAllowed = () => true;

const buildCorsOriginHandler = () => (origin, callback) => {
  if (isOriginAllowed(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS`));
};

const buildSocketCorsOptions = () => {
  return {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by Socket.IO CORS`));
    },
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

const resolveWebsiteOrigin = (req) => {
  const origin = trimOrigin(getRequestOrigin(req));
  if (origin) {
    return origin;
  }

  const envOrigin = trimOrigin(process.env.WEBSITE_ORIGIN);
  if (envOrigin) {
    return envOrigin;
  }

  if (process.env.NODE_ENV === 'test') {
    return 'https://www.wulfara.test';
  }

  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:3000';
  }

  return '';
};

const resolveDashboardOrigin = (req) => {
  const origin = trimOrigin(getRequestOrigin(req));
  if (origin) {
    return origin;
  }

  const envOrigin = trimOrigin(process.env.DASHBOARD_ORIGIN);
  if (envOrigin) {
    return envOrigin;
  }

  if (process.env.NODE_ENV === 'test') {
    return 'https://dashboard.wulfara.test';
  }

  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:5173';
  }

  return '';
};

module.exports = {
  buildCorsOriginHandler,
  buildSocketCorsOptions,
  getRequestOrigin,
  getConfiguredOrigins,
  isOriginAllowed,
  resolveDashboardOrigin,
  resolveWebsiteOrigin,
  resolveAppOrigin,
  trimOrigin,
};
