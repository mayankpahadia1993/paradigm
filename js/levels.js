// Google-style card-level helpers shared by the app and the test suite.
(function (root) {
  const TIERS = ["L3", "L4", "L5", "L6", "L7"];
  const LABELS = {
    L3: "Early career · foundations",
    L4: "Mid-level · builder",
    L5: "Senior · architect",
    L6: "Staff · operator",
    L7: "Senior Staff+ · strategy",
  };

  function normalizeMinimumTier(value) {
    return TIERS.includes(value) ? value : TIERS[0];
  }

  function meetsMinimumTier(card, minimumTier) {
    if (!card || !TIERS.includes(card.tier)) return false;
    return TIERS.indexOf(card.tier) >= TIERS.indexOf(normalizeMinimumTier(minimumTier));
  }

  function filterCards(cards, minimumTier) {
    return cards.filter((card) => meetsMinimumTier(card, minimumTier));
  }

  const api = { TIERS, LABELS, normalizeMinimumTier, meetsMinimumTier, filterCards };
  root.ParadigmLevels = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
