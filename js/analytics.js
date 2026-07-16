// Analytics (optional): GoatCounter (privacy-light) and/or Google Analytics 4.
// Both honor Do Not Track and no-op until their id is set, so the app runs
// identically with or without them.
//
// ─── GOATCOUNTER ─────────────────────────────────────────────────────────────
// 1. Create a free account at https://www.goatcounter.com (pick a site code).
// 2. Put the code below (just the subdomain, e.g. "paradigm" for
//    https://paradigm.goatcounter.com).
// You then get: visitors, pageviews, country-level geo, referrers, browsers, and
// the custom events fired via track() (session-start, session-complete, quiz-*,
// onboarding-complete, and how the app was launched).
//
// ─── GOOGLE ANALYTICS 4 ──────────────────────────────────────────────────────
// 1. Create a property at https://analytics.google.com, add a Web data stream
//    for the app's URL, and copy its Measurement ID ("G-XXXXXXXXXX").
// 2. Put it in `ga4` below and redeploy.
// track() events land in GA4 with an "app_" prefix and hyphens as underscores
// (session-start → app_session_start) — the prefix keeps them clear of GA4's
// reserved auto-event names like session_start. Note GA4 sets cookies; the
// GoatCounter side does not.
window.PARADIGM_ANALYTICS = {
  goatcounter: "mp27try", // GoatCounter site code (subdomain of the count endpoint)
  ga4: "G-FD7L9WS54Z", // GA4 Measurement ID — empty disables GA4
};

(function () {
  const cfg = window.PARADIGM_ANALYTICS;
  const http = location.protocol.startsWith("http");
  // Respect Do Not Track across both backends (GoatCounter's count.js also
  // does on its own, but bail early and keep GA4 to the same standard).
  const dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1";
  const gcOn = !!cfg.goatcounter && http && !dnt;
  const gaOn = !!cfg.ga4 && http && !dnt;

  // track(name) — records a custom event on every enabled backend. Safe to call
  // whether or not analytics is enabled; GoatCounter events queue until count.js
  // loads, GA4 events queue in the dataLayer until gtag.js loads.
  const gcQueue = [];
  const gcSend = (name) =>
    window.goatcounter.count({ path: "evt/" + name, title: "event: " + name, event: true });
  window.track = function (name) {
    if (gcOn) {
      if (window.goatcounter && window.goatcounter.count) gcSend(name);
      else gcQueue.push(name);
    }
    if (gaOn) window.gtag("event", "app_" + name.replace(/-/g, "_"));
  };

  if (!gcOn && !gaOn) return;

  if (gaOn) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", cfg.ga4);
    const g = document.createElement("script");
    g.async = true;
    g.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.ga4);
    document.head.appendChild(g);
  }

  if (gcOn) {
    window.goatcounter = window.goatcounter || {};
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://gc.zgo.at/count.js";
    s.dataset.goatcounter = `https://${cfg.goatcounter}.goatcounter.com/count`;
    s.addEventListener("load", () => {
      while (gcQueue.length) gcSend(gcQueue.shift());
    });
    document.head.appendChild(s);
  }

  // How was the app launched? Standalone = installed to home screen (the key
  // engagement signal for the micro-session use case); browser = a tab.
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  window.track(standalone ? "launch-standalone" : "launch-browser");
})();
