// FSRS scheduler (FSRS-5 shape, default weights) — PRD §7.
// Per-card memory state: stability (days), difficulty (1..10), due timestamp.
// Grades: 1=Again, 2=Hard, 3=Good, 4=Easy.
(function () {
  const W = [
    0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
    0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567,
  ];
  const DECAY = -0.5;
  const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // ≈ 19/81, so R(t=S) = 0.9
  const REQUEST_RETENTION = 0.9;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function retrievability(elapsedDays, stability) {
    if (elapsedDays <= 0) return 1;
    return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
  }

  function initDifficulty(grade) {
    return clamp(W[4] - Math.exp(W[5] * (grade - 1)) + 1, 1, 10);
  }

  function nextDifficulty(d, grade) {
    const dNew = d - W[6] * (grade - 3);
    // mean reversion toward the "Easy" initial difficulty
    return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * dNew, 1, 10);
  }

  function stabilityOnSuccess(d, s, r, grade) {
    const hardPenalty = grade === 2 ? W[15] : 1;
    const easyBonus = grade === 4 ? W[16] : 1;
    return (
      s *
      (1 +
        Math.exp(W[8]) *
          (11 - d) *
          Math.pow(s, -W[9]) *
          (Math.exp(W[10] * (1 - r)) - 1) *
          hardPenalty *
          easyBonus)
    );
  }

  function stabilityOnLapse(d, s, r) {
    const sNew =
      W[11] *
      Math.pow(d, -W[12]) *
      (Math.pow(s + 1, W[13]) - 1) *
      Math.exp(W[14] * (1 - r));
    return Math.min(sNew, s); // a lapse never increases stability
  }

  // FSRS-5 short-term (same-day) stability: S' = S · e^(w17·(G−3+w18)).
  // Applies when a card is re-reviewed the same day (e.g. after an Again relearn
  // step) — the long-term formula gives ~no growth at R≈1, understating intervals.
  function stabilityShortTerm(s, grade) {
    return s * Math.exp(W[17] * (grade - 3 + W[18]));
  }

  // FSRS-5's short-term regime is for reviews on the SAME calendar day (relearn
  // steps, quiz re-injections). A plain `elapsed < 1` check misfires: the Today
  // queue pulls in anything due by end of day, so a card graded yesterday evening
  // gets reviewed next morning <24h later — and the short-term formula barely
  // moves stability (Hard shrinks it), trapping the card at "1d" for every grade.
  function sameCalendarDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return (
      da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate()
    );
  }

  function intervalDays(stability) {
    const ivl = (stability / FACTOR) * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
    // Cap at 1 year (FSRS default is 100y) — deliberate for interview prep, where
    // a card you'll be tested on soon should never drift years out.
    return clamp(Math.round(ivl), 1, 365);
  }

  // Review a card. state = null for a brand-new card.
  // Returns the new state {stability, difficulty, due, lastReview, reps, lapses}.
  function review(state, grade, now) {
    now = now || Date.now();
    if (!state) {
      const stability = Math.max(W[grade - 1], 0.1);
      const due =
        grade === 1
          ? now + 10 * 60 * 1000 // Again on a new card: re-see within the session
          : now + intervalDays(stability) * DAY_MS;
      return {
        stability,
        difficulty: initDifficulty(grade),
        due,
        lastReview: now,
        reps: 1,
        lapses: grade === 1 ? 1 : 0,
      };
    }

    const elapsedDays = Math.max(0, (now - state.lastReview) / DAY_MS);
    const sameDay = sameCalendarDay(now, state.lastReview); // FSRS-5 short-term regime
    const r = retrievability(elapsedDays, state.stability);
    const difficulty = nextDifficulty(state.difficulty, grade);
    let stability, due, lapses = state.lapses || 0;

    if (grade === 1) {
      stability = sameDay
        ? Math.max(stabilityShortTerm(state.stability, grade), 0.1)
        : Math.max(stabilityOnLapse(state.difficulty, state.stability, r), 0.1);
      lapses += 1;
      due = now + 10 * 60 * 1000; // relearn within the session
    } else {
      stability = sameDay
        ? stabilityShortTerm(state.stability, grade)
        : stabilityOnSuccess(state.difficulty, state.stability, r, grade);
      let ivl = intervalDays(stability);
      // Easy must always clear Good (Anki's FSRS does the same) — otherwise on
      // low-stability cards rounding collapses every grade to the same "1d" pill.
      if (grade === 4) {
        const goodStability = sameDay
          ? stabilityShortTerm(state.stability, 3)
          : stabilityOnSuccess(state.difficulty, state.stability, r, 3);
        ivl = Math.max(ivl, intervalDays(goodStability) + 1);
      }
      due = now + ivl * DAY_MS;
    }

    return {
      stability,
      difficulty,
      due,
      lastReview: now,
      reps: (state.reps || 0) + 1,
      lapses,
    };
  }

  // Current recall probability for a card (drives Progress mastery, PRD §7).
  function currentRetrievability(state, now) {
    if (!state) return 0;
    now = now || Date.now();
    const elapsedDays = Math.max(0, (now - state.lastReview) / DAY_MS);
    return retrievability(elapsedDays, state.stability);
  }

  // Preview interval labels for the grade pills ("Again <10m · Good 3d …").
  function previewIntervals(state, now) {
    now = now || Date.now();
    const label = (ms) => {
      const days = ms / DAY_MS;
      if (days < 1) return "<10m";
      if (days < 30) return Math.round(days) + "d";
      return (days / 30).toFixed(1).replace(/\.0$/, "") + "mo";
    };
    const out = {};
    for (let g = 1; g <= 4; g++) {
      const s = review(state, g, now);
      out[g] = label(s.due - now);
    }
    return out;
  }

  window.FSRS = { review, currentRetrievability, previewIntervals, DAY_MS };
})();
