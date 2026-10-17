// Mystico "Portal" sting — the studio intro over the app at a fresh launch.
//
// The same contract as RallyCade's (iOS MysticoStingView / Android
// MysticoStingOverlay): 4.5 s over everything, the last 0.6 s fading picture and
// sound; a tap, Escape, Enter or Space fades it out over 0.6 s; reduced motion
// shows the still with the same sound; a missing film opens the app at once and
// a stalled one by 7 s. Nothing under it takes input while it shows.
//
// Whether it shows is decided by the inline <head> script in index.html before
// the first paint (once per browser session; ?sting=on|off; webdriver skips).
// This file plays it. Tests read window.MysticoSting.log: started, finished,
// skipped.
(function (root) {
  const SECONDS = 4.5;
  const FADE = 0.6;
  const SAFETY = SECONDS + 2.5;
  const FILMS = {
    portrait: { film: "brand/mystico-sting-portrait.mp4", still: "brand/mystico-sting-portrait-still.png" },
    landscape: { film: "brand/mystico-sting.mp4", still: "brand/mystico-sting-still.png" },
  };
  const SKIP_KEYS = ["Escape", "Esc", "Enter", " ", "Spacebar"];

  // Taller than wide → the portrait film; otherwise (square too) the landscape one.
  function shapeFor(width, height) {
    return height > width ? "portrait" : "landscape";
  }

  const api = { SECONDS, FADE, SAFETY, FILMS, SKIP_KEYS, shapeFor };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  const w = root;
  const d = w.document;
  const sting = w.MysticoSting || (w.MysticoSting = { showing: false, log: [], done: Promise.resolve() });
  Object.assign(sting, api);
  const el = d.getElementById("mystico-sting");
  if (!sting.showing || sting.started || !el) {
    if (el && !sting.showing) el.remove();
    return;
  }

  const video = d.getElementById("mystico-sting-film");
  const still = d.getElementById("mystico-sting-still");
  const app = d.getElementById("app");
  const t0 = sting.t0 || Date.now();
  const timers = [];
  const later = (fn, seconds) => timers.push(w.setTimeout(fn, Math.max(0, seconds * 1000)));
  let leaving = false;
  let timeline = false;
  const pointersDown = new Set();
  let swallowClick = null;

  sting.started = true;
  sting.startedAt = performance.now();
  sting.log.push("started");
  sting.shape = shapeFor(w.innerWidth, w.innerHeight);
  const reduced = !!(w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const files = FILMS[sting.shape];

  if (app) app.inert = true;
  try { el.focus({ preventScroll: true }); } catch (e) {}

  // Never more than 7 s from the first paint: begin the last fade in time.
  later(() => leave(false, "safety"), SAFETY - FADE - (Date.now() - t0) / 1000);

  el.addEventListener("click", (e) => { e.preventDefault(); leave(true, "tap"); });
  w.addEventListener("keydown", onKey, true);
  w.addEventListener("pointerdown", onPointerDown, true);
  w.addEventListener("pointerup", onPointerUp, true);
  w.addEventListener("pointercancel", onPointerUp, true);

  function onKey(e) {
    if (!sting.showing || e.metaKey || e.ctrlKey || e.altKey) return;
    // Nothing underneath sees keys while the sting shows.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (SKIP_KEYS.includes(e.key)) leave(true, "key");
  }
  function onPointerDown(e) { if (sting.showing) pointersDown.add(e.pointerId); }
  function onPointerUp(e) {
    pointersDown.delete(e.pointerId);
    // The click that follows this release still belongs to the sting.
    if (!pointersDown.size && swallowClick) w.setTimeout(stopSwallowing, 400);
  }
  function stopSwallowing() {
    if (swallowClick) w.removeEventListener("click", swallowClick, true);
    swallowClick = null;
    w.removeEventListener("pointerup", onPointerUp, true);
    w.removeEventListener("pointercancel", onPointerUp, true);
  }

  // The 4.5 s run from when the picture (or the still) is really there.
  function startTimeline() {
    if (timeline || leaving) return;
    timeline = true;
    sting.mode = el.classList.contains("still") ? "still" : "film";
    sting.timelineAt = performance.now();
    later(() => leave(false, "ended"), SECONDS - FADE);
  }

  function playStill(withSound) {
    if (!sting.showing || leaving) return;
    el.classList.add("still");
    if (!withSound) { try { video.pause(); } catch (e) {} video.removeAttribute("src"); }
    const shown = () => { el.classList.add("still-on"); startTimeline(); };
    still.addEventListener("load", shown, { once: true });
    still.addEventListener("error", () => finish(false, "missing-still"), { once: true });
    still.src = files.still;
    if (still.complete && still.naturalWidth) shown();
  }

  // With sound when the browser allows it; muted otherwise (never an unmute prompt).
  function play() {
    video.muted = false;
    video.volume = 1;
    const tryPlay = () => { try { return Promise.resolve(video.play()); } catch (e) { return Promise.reject(e); } };
    return tryPlay().then(() => "sound", () => {
      if (leaving) return "none";
      video.muted = true;
      sting.muted = true;
      return tryPlay().then(() => "muted", () => "none");
    });
  }

  const mp4 = video.canPlayType && video.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"');
  if (d.visibilityState === "hidden") {
    // Opened in a background tab or prerendered: nobody would see it.
    finish(false, "hidden");
  } else if (reduced) {
    // Reduced motion: no flash. The still fades in, holds and fades out; the
    // film plays unseen for its sound only when the browser lets it have sound.
    sting.mode = "still";
    if (mp4) {
      video.src = files.film;
      play().then((how) => { if (how !== "sound") { try { video.pause(); } catch (e) {} } });
    }
    playStill(true);
  } else if (!mp4) {
    // A browser that can't decode the film still gets the brand moment, silent.
    playStill(false);
  } else {
    video.addEventListener("playing", startTimeline, { once: true });
    video.addEventListener("error", () => finish(false, "missing-film"), { once: true });
    video.src = files.film;
    play().then((how) => { if (how === "none" && !leaving) playStill(false); });
  }

  function leave(skipped, reason) {
    if (leaving || !sting.showing) return;
    leaving = true;
    sting.reason = reason;
    timers.forEach((t) => w.clearTimeout(t));
    el.classList.add("leaving");
    fadeSound();
    w.setTimeout(() => finish(skipped, reason), FADE * 1000);
  }

  function fadeSound() {
    if (!video.src || video.paused || video.muted) return;
    const from = video.volume;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / (FADE * 1000));
      try { video.volume = from * (1 - k); } catch (e) {}
      if (k < 1 && !video.paused) w.requestAnimationFrame(step);
    };
    w.requestAnimationFrame(step);
  }

  function finish(skipped, reason) {
    if (!sting.showing) return;
    sting.showing = false;
    sting.reason = sting.reason || reason;
    leaving = true;
    timers.forEach((t) => w.clearTimeout(t));
    sting.log.push(skipped ? "skipped" : "finished");
    sting.endedAt = performance.now();
    try { video.pause(); } catch (e) {}
    video.removeAttribute("src");
    try { video.load(); } catch (e) {}
    el.remove();
    d.documentElement.classList.remove("sting");
    const theme = d.querySelector('meta[name="theme-color"]');
    if (theme && sting.theme) theme.content = sting.theme;
    if (app) app.inert = false;
    w.removeEventListener("keydown", onKey, true);
    w.removeEventListener("pointerdown", onPointerDown, true);
    // A finger still down from the sting must not land a click on the app.
    if (pointersDown.size) {
      swallowClick = (e) => { e.preventDefault(); e.stopImmediatePropagation(); stopSwallowing(); };
      w.addEventListener("click", swallowClick, true);
      w.setTimeout(stopSwallowing, 10000);
    } else {
      stopSwallowing();
    }
    if (sting.resolveDone) sting.resolveDone();
    w.dispatchEvent(new Event("mystico-sting-done"));
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
