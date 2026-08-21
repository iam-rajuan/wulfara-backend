const FEATURED_HERO_PLACEMENT = Object.freeze({
  code: 'featured_hero_placement',
  name: 'Featured Hero Placement',
  price: 15,
  description: 'Pin your listing to the top of category searches.',
});

const SUPPORTED_SUBSCRIPTION_ADDONS = Object.freeze({
  [FEATURED_HERO_PLACEMENT.code]: FEATURED_HERO_PLACEMENT,
});

const normalizeRequestedAddons = (payload = {}) => {
  const requested = [];

  if (Array.isArray(payload.addons)) {
    requested.push(...payload.addons);
  }

  if (payload.featuredHeroPlacement === true) {
    requested.push(FEATURED_HERO_PLACEMENT.code);
  }

  return [...new Set(requested.filter(Boolean).map((code) => String(code).trim()))];
};

const resolveSubscriptionAddons = (payload = {}) => {
  const requestedCodes = normalizeRequestedAddons(payload);
  const unsupportedCodes = requestedCodes.filter((code) => !SUPPORTED_SUBSCRIPTION_ADDONS[code]);

  return {
    requestedCodes,
    unsupportedCodes,
    addons: requestedCodes
      .filter((code) => SUPPORTED_SUBSCRIPTION_ADDONS[code])
      .map((code) => SUPPORTED_SUBSCRIPTION_ADDONS[code]),
  };
};

const sumAddonAmount = (addons = []) =>
  addons.reduce((total, addon) => total + Number(addon?.price || 0), 0);

module.exports = {
  FEATURED_HERO_PLACEMENT,
  SUPPORTED_SUBSCRIPTION_ADDONS,
  normalizeRequestedAddons,
  resolveSubscriptionAddons,
  sumAddonAmount,
};
