// Paradigm prototype — app shell, card canvas, quiz flow, progress, PWA.
(function () {
  const CONTENT = window.PARADIGM_CONTENT;
  const FSRS = window.FSRS;
  const Levels = window.ParadigmLevels;
  const cardsById = Object.fromEntries(CONTENT.cards.map((c) => [c.id, c]));

  const TYPE_ACCENT = {
    concept: "var(--type-concept)",
    "trade-off": "var(--type-trade-off)",
    numbers: "var(--type-numbers)",
    scenario: "var(--type-scenario)",
    critique: "var(--type-critique)",
    "post-mortem": "var(--type-post-mortem)",
  };
  const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100];
  const FEEDBACK_EMAIL = "mp27try@gmail.com";

  // "Dispute this card" (PRD §13) — prefilled feedback email
  function feedbackUrl(card) {
    const subject = card ? `[Paradigm card] ${card.id}` : "[Paradigm] feedback";
    const body = card
      ? `Card: ${card.id} (${card.deck} · ${card.tier} · ${card.type} · content v${CONTENT.version})\n\nWhat's wrong, or what could be better?\n\n`
      : `Content version: v${CONTENT.version}\n\nWhat happened, or what's your idea?\n\n`;
    return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
  // mailto via window.open is unreliable on iOS — assigning location opens the
  // mail composer without unloading the app.
  function openFeedback(card) { window.location.href = feedbackUrl(card); }

  // ---------- persistent state (the GRDB analog, PRD §8.3) ----------
  const STORE_KEY = "paradigm.v1";
  let store = load();
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}
    if (!s || !s.cardState) {
      s = {
        cardState: {},          // card_id -> FSRS state
        reviewLog: [],          // append-only: {cardId, ts, grade}
        quizLog: [],            // {deck, ts, score, total}
        bookmarks: {},          // card_id -> true
        streak: { count: 0, lastDay: null },
        newPerDay: 10,
        introduced: { day: null, count: 0 },
      };
    }
    // v2 fields (migrate v1 stores)
    if (!s.subs) { s.subs = {}; CONTENT.decks.forEach((d) => (s.subs[d.id] = true)); }
    CONTENT.decks.forEach((d) => { if (!(d.id in s.subs)) s.subs[d.id] = true; });
    if (!("interviewDate" in s)) s.interviewDate = null;
    if (!("lastMilestone" in s)) s.lastMilestone = 0;
    if (!("seenContentVersion" in s)) s.seenContentVersion = 0;
    s.minimumTier = Levels.normalizeMinimumTier(s.minimumTier);
    return s;
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  const dayKey = (ts) => {
    const d = new Date(ts === undefined ? Date.now() : ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  function bumpStreak() {
    const today = dayKey();
    if (store.streak.lastDay === today) return;
    const yesterday = dayKey(Date.now() - FSRS.DAY_MS);
    store.streak.count = store.streak.lastDay === yesterday ? store.streak.count + 1 : 1;
    store.streak.lastDay = today;
  }

  // ---------- crunch mode (PRD §7: interview-date intensity ramp) ----------
  function daysToInterview() {
    if (!store.interviewDate) return null;
    const target = new Date(store.interviewDate + "T00:00:00");
    return Math.ceil((target.getTime() - Date.now()) / FSRS.DAY_MS);
  }
  function effectiveNewPerDay() {
    const d = daysToInterview();
    if (d === null || d < 0) return store.newPerDay;
    if (d <= 7) return 25;
    if (d <= 14) return 20;
    if (d <= 30) return 15;
    return store.newPerDay;
  }

  // ---------- tiny markdown renderer for card bodies ----------
  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = (s) =>
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    const lines = md.split("\n");
    let html = "", list = null, para = [];
    const flushPara = () => { if (para.length) { html += "<p>" + inline(para.join(" ")) + "</p>"; para = []; } };
    const flushList = () => { if (list) { html += list.tag === "ol" ? "<ol>" + list.items + "</ol>" : "<ul>" + list.items + "</ul>"; list = null; } };
    for (const raw of lines) {
      const line = raw.trim();
      const ol = line.match(/^\d+\.\s+(.*)/);
      const ul = line.match(/^-\s+(.*)/);
      if (ol || ul) {
        flushPara();
        const tag = ol ? "ol" : "ul";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: "" }; }
        list.items += "<li>" + inline((ol || ul)[1]) + "</li>";
      } else if (line === "") {
        flushPara(); flushList();
      } else {
        flushList(); para.push(line);
      }
    }
    flushPara(); flushList();
    return html;
  }

  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const haptic = (ms) => { if (navigator.vibrate && !reduceMotion.matches) navigator.vibrate(ms || 10); };
  let toastTimer;
  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), ms || 1800);
  }

  function diagramHtml(card, context) {
    if (!card.diagram) return "";
    const alt = card.diagram.alt.replace(/"/g, "&quot;");
    return `
      <button class="card-diagram" data-card="${card.id}" aria-label="Open diagram: ${alt}">
        <img src="${card.diagram.dark}" alt="${alt}" loading="lazy" draggable="false" />
        ${context === "card" ? '<div class="card-diagram-hint">tap diagram to zoom</div>' : ""}
      </button>`;
  }

  // ---------- queue building (PRD §7: due cards + new-card throttle) ----------
  function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
  function newBudget() {
    if (store.introduced.day !== dayKey()) { store.introduced = { day: dayKey(), count: 0 }; }
    return Math.max(0, effectiveNewPerDay() - store.introduced.count);
  }
  function rotationCards() {
    return CONTENT.cards.filter((c) => store.subs[c.deck] && Levels.meetsMinimumTier(c, store.minimumTier));
  }
  function buildQueue() {
    const due = rotationCards()
      .filter((c) => store.cardState[c.id] && store.cardState[c.id].due <= endOfToday())
      .sort((a, b) => store.cardState[a.id].due - store.cardState[b.id].due);
    const fresh = rotationCards().filter((c) => !store.cardState[c.id]).slice(0, newBudget());
    return [...due, ...fresh].map((c) => c.id);
  }

  // ---------- Today ----------
  function renderToday() {
    const queue = buildQueue();
    const dueN = queue.filter((id) => store.cardState[id]).length;
    const newN = queue.length - dueN;
    const caughtUp = queue.length === 0;
    $("due-count").textContent = caughtUp ? "✓" : queue.length;
    $("due-label").textContent = caughtUp ? "all caught up" : (queue.length === 1 ? "card due today" : "cards due today");
    $("due-breakdown").textContent = caughtUp
      ? `nothing due at ${store.minimumTier}+ — nice work`
      : `${dueN} review · ${newN} new · ${store.minimumTier}+`;
    // "🔥 0" on day one reads as failure — invite instead
    const sp = $("streak-pill");
    sp.textContent = store.streak.count > 0 ? `🔥 ${store.streak.count}` : "Start your streak";
    sp.setAttribute("aria-label", store.streak.count > 0 ? `Streak: ${store.streak.count} days` : "No streak yet");
    // Empty queue is never a dead end — always offer a next action
    $("btn-start-review").classList.toggle("hidden", caughtUp);
    $("btn-caught-up").classList.toggle("hidden", !caughtUp);
    $("btn-quick-session").classList.toggle("hidden", caughtUp);
    $("due-count").classList.toggle("caught-up", caughtUp);

    const d = daysToInterview();
    const banner = $("crunch-banner");
    if (d !== null && d >= 0) {
      banner.textContent = d === 0
        ? "🎯 Interview day. Light review only — you've got this."
        : `🎯 Interview in ${d} day${d === 1 ? "" : "s"} · crunch mode: ${effectiveNewPerDay()} new cards/day`;
      banner.classList.remove("hidden");
      $("btn-interview-date").textContent = "🎯 Change interview date";
    } else {
      banner.classList.add("hidden");
      $("btn-interview-date").textContent = "🎯 Set interview date";
    }

    $("today-hint").textContent = queue.length
      ? "Tap to flip · swipe right = knew it · swipe left = again · swipe up = why"
      : "All caught up. Come back tomorrow, or take a micro-quiz in the Library.";
  }

  // ---------- Library ----------
  function deckMastery(deckId, scope) {
    const cards = (scope || CONTENT.cards).filter((c) => c.deck === deckId);
    if (!cards.length) return 0;
    const sum = cards.reduce((acc, c) => acc + FSRS.currentRetrievability(store.cardState[c.id]), 0);
    return sum / cards.length;
  }
  function renderLibrary() {
    const bookmarked = Object.keys(store.bookmarks).filter((id) => store.bookmarks[id] && cardsById[id]);
    const bRow = $("bookmarks-row");
    bRow.innerHTML = bookmarked.length
      ? `<button class="bookmarks-card" id="btn-bookmarks">✦ Bookmarked cards <span>${bookmarked.length} · browse</span></button>`
      : "";
    if (bookmarked.length) $("btn-bookmarks").addEventListener("click", () => startSession(bookmarked, { browse: true }));

    const el = $("deck-list");
    el.innerHTML = "";
    for (const deck of CONTENT.decks) {
      const quiz = CONTENT.quizzes.find((q) => q.deck === deck.id);
      const mastery = Math.round(deckMastery(deck.id) * 100);
      const subbed = !!store.subs[deck.id];
      const row = document.createElement("div");
      row.className = "deck-row" + (subbed ? "" : " unsubscribed");
      row.innerHTML = `
        <div class="deck-top">
          <div>
            <div class="deck-name">${deck.name}</div>
            <div class="deck-meta">${deck.card_count} cards · ${mastery}% mastery</div>
          </div>
          <div class="tier-badges">${deck.tiers.map((t) => `<span class="tier-badge">${t}</span>`).join("")}</div>
        </div>
        <div class="deck-mastery-bar"><div class="deck-mastery-fill" style="width:${mastery}%"></div></div>
        <div class="deck-actions">
          <button class="btn-small" data-browse="${deck.id}">Browse</button>
          ${quiz ? `<button class="btn-small primary" data-quiz="${deck.id}">Micro-quiz (${quiz.questions.length})</button>` : ""}
        </div>
        <div class="deck-sub-row">
          <span>${subbed ? "In your review rotation" : "Not in rotation — cards won't appear in Today"}</span>
          <button class="sub-toggle ${subbed ? "on" : ""}" data-sub="${deck.id}" aria-label="toggle rotation"></button>
        </div>`;
      el.appendChild(row);
    }
    el.querySelectorAll("[data-quiz]").forEach((b) => b.addEventListener("click", () => startQuiz(b.dataset.quiz)));
    el.querySelectorAll("[data-browse]").forEach((b) => b.addEventListener("click", () => startBrowse(b.dataset.browse)));
    el.querySelectorAll("[data-sub]").forEach((b) =>
      b.addEventListener("click", () => {
        store.subs[b.dataset.sub] = !store.subs[b.dataset.sub];
        save(); haptic(8); renderLibrary();
      })
    );
  }

  // ---------- Progress ----------
  function renderHeatmap() {
    const counts = {};
    for (const r of store.reviewLog) counts[dayKey(r.ts)] = (counts[dayKey(r.ts)] || 0) + 1;
    const el = $("heatmap");
    el.innerHTML = "";
    const days = 12 * 7;
    for (let i = days - 1; i >= 0; i--) {
      const n = counts[dayKey(Date.now() - i * FSRS.DAY_MS)] || 0;
      const cls = n === 0 ? "" : n < 5 ? "h1" : n < 10 ? "h2" : n < 20 ? "h3" : "h4";
      const cell = document.createElement("div");
      cell.className = "heat-cell " + cls;
      cell.title = `${dayKey(Date.now() - i * FSRS.DAY_MS)}: ${n} reviews`;
      el.appendChild(cell);
    }
  }

  function weakestCards(n) {
    const rotationIds = new Set(rotationCards().map((c) => c.id));
    return CONTENT.cards
      .filter((c) => rotationIds.has(c.id))
      .filter((c) => store.cardState[c.id] && (store.cardState[c.id].reps || 0) > 0)
      .map((c) => {
        const st = store.cardState[c.id];
        const r = FSRS.currentRetrievability(st);
        return { card: c, r, lapses: st.lapses || 0, score: r - 0.05 * (st.lapses || 0) };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, n);
  }

  function renderProgress() {
    const list = $("mastery-list");
    list.innerHTML = "";
    const eligible = rotationCards();
    let weighted = 0, totalCards = 0;
    for (const deck of CONTENT.decks) {
      const deckCards = eligible.filter((c) => c.deck === deck.id);
      if (!deckCards.length) continue;
      const m = deckMastery(deck.id, eligible);
      weighted += m * deckCards.length;
      totalCards += deckCards.length;
      const row = document.createElement("div");
      row.className = "mastery-row";
      row.innerHTML = `
        <div class="mastery-name">${deck.name}</div>
        <div class="mastery-bar"><div class="mastery-fill" style="width:${Math.round(m * 100)}%"></div></div>
        <div class="mastery-pct">${Math.round(m * 100)}%</div>`;
      list.appendChild(row);
    }
    const readiness = totalCards ? Math.round((weighted / totalCards) * 100) : 0;
    const hasEligibleReviews = eligible.some((c) => store.cardState[c.id] && (store.cardState[c.id].reps || 0) > 0);
    $("readiness-num").textContent = hasEligibleReviews ? readiness + "%" : "–";
    $("readiness-ring").style.setProperty("--pct", hasEligibleReviews ? readiness : 0);
    $("readiness-label").textContent = hasEligibleReviews
      ? `${store.minimumTier}+ readiness · weighted recall across ${totalCards} cards`
      : "Start reviewing to build your readiness score";

    renderHeatmap();

    const weak = weakestCards(5);
    const wEl = $("weakest-list");
    $("weakest-title").style.display = weak.length ? "" : "none";
    wEl.innerHTML = weak.length
      ? ""
      : "";
    for (const w of weak) {
      const row = document.createElement("div");
      row.className = "weak-row";
      row.innerHTML = `
        <div style="flex:1">
          <div class="weak-title">${w.card.title}</div>
          <div class="weak-meta">${w.card.deck} · ${w.card.tier} · ${w.lapses} lapse${w.lapses === 1 ? "" : "s"}</div>
        </div>
        <div class="weak-pct">${Math.round(w.r * 100)}%</div>`;
      wEl.appendChild(row);
    }
    if (weak.length) {
      const btn = document.createElement("button");
      btn.className = "btn-ghost";
      btn.style.width = "100%";
      btn.textContent = "Drill weakest cards";
      btn.addEventListener("click", () => startSession(weak.map((w) => w.card.id), { browse: true }));
      wEl.appendChild(btn);
    }

    const seen = eligible.filter((c) => store.cardState[c.id]).length;
    $("stat-row").innerHTML = `
      <div><b>${store.reviewLog.length}</b>reviews</div>
      <div><b>${seen}/${totalCards}</b>cards seen</div>
      <div><b>${store.streak.count}</b>day streak</div>`;
    $("minimum-tier-select").value = store.minimumTier;
  }

  // ---------- tabs ----------
  const views = { today: renderToday, library: renderLibrary, progress: renderProgress };
  function switchTab(view) {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.view === view;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    for (const v of Object.keys(views)) $("view-" + v).classList.toggle("hidden", v !== view);
    views[view]();
  }
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.view);
      haptic(5);
    })
  );

  // ---------- review session ----------
  let session = null; // {queue, index, flipped, browse, doneCount, againCount, startTs}

  function startSession(queue, opts) {
    if (!queue.length) return;
    session = {
      queue: queue.slice(), index: 0, flipped: false,
      browse: !!(opts && opts.browse), doneCount: 0, againCount: 0, startTs: Date.now(),
      history: [],
    };
    $("review-overlay").classList.remove("hidden");
    $("session-done").classList.add("hidden");
    if (!session.browse && window.track) track("session-start");
    showCard();
  }
  function startBrowse(deckId) {
    startSession(CONTENT.cards.filter((c) => c.deck === deckId).map((c) => c.id), { browse: true });
  }

  function cardsDeckName(deckId) {
    const d = CONTENT.decks.find((x) => x.id === deckId);
    return d ? d.name : deckId;
  }
  function cardFaceHtml(card, side) {
    const accent = TYPE_ACCENT[card.type] || "var(--accent)";
    return `
      <div class="card-tag-row" style="--card-accent:${accent}">
        <span class="card-type-chip" style="--card-accent:${accent}">${card.type}</span>
        <span class="card-tier-chip">${card.tier}</span>
        ${store.bookmarks[card.id] ? '<span class="card-tier-chip">✦</span>' : ""}
        <span class="card-deck-chip">${cardsDeckName(card.deck)}</span>
        ${side === "back" ? '<button class="card-flag" title="flag this card" aria-label="flag this card">⚑</button>' : ""}
      </div>
      ${side === "back" ? `<div class="card-q-recap">${mdToHtml(card.front)}</div>` : ""}
      <div class="card-content">
        ${mdToHtml(side === "front" ? card.front : card.back)}
        ${side === "back" ? diagramHtml(card, "card") : ""}
      </div>
      ${side === "back" && (card.explanation || card.followups.length)
        ? '<button class="card-why-btn" data-why="1">Why &amp; follow-ups <span aria-hidden="true">⌄</span></button>'
        : ""}`;
  }

  function currentCard() { return cardsById[session.queue[session.index]]; }

  // "⌄" pill at the card's bottom edge whenever the visible face has more content
  // below the fold — without it, testers read a clipped diagram as a rendering bug.
  function updateScrollMoreHint() {
    const hint = $("scroll-more");
    if (!session) { hint.classList.add("hidden"); return; }
    const face = session.flipped ? $("card-back") : $("card-front");
    const below = face.scrollHeight - face.clientHeight - face.scrollTop;
    hint.classList.toggle("hidden", below <= 16);
  }
  ["card-front", "card-back"].forEach((id) => $(id).addEventListener("scroll", updateScrollMoreHint));

  function showCard() {
    const card = currentCard();
    if (!card) return endSession(true);
    session.flipped = false;
    const cardEl = $("card");
    cardEl.classList.add("no-anim");
    cardEl.classList.remove("flipped");
    requestAnimationFrame(() => requestAnimationFrame(() => cardEl.classList.remove("no-anim")));
    const accent = TYPE_ACCENT[card.type] || "var(--accent)";
    $("card-front").style.setProperty("--card-accent", accent);
    $("card-back").style.setProperty("--card-accent", accent);
    $("card-front").innerHTML = cardFaceHtml(card, "front");
    $("card-back").innerHTML = cardFaceHtml(card, "back");
    // VoiceOver: only the visible face is exposed; announce the new card
    $("card-front").setAttribute("aria-hidden", "false");
    $("card-back").setAttribute("aria-hidden", "true");
    $("card").setAttribute("aria-label", `${card.type} card, ${card.tier}: ${card.title}. Front showing. Double-tap to flip.`);
    $("grade-row").classList.add("hidden");
    $("flip-hint").classList.remove("hidden");
    updateUndoButton();
    $("flip-hint").textContent = session.browse
      ? "tap to flip · swipe → next · ↑ why"
      : "tap to flip · swipe ← again · → good · ↑ why";
    const remaining = session.queue.length - session.index;
    $("session-count").textContent = session.browse ? `${session.index + 1}/${session.queue.length}` : `${remaining} left`;
    const pct = Math.round((session.index / session.queue.length) * 100);
    $("session-progress-fill").style.width = pct + "%";
    const pb = document.querySelector(".session-progress");
    if (pb) pb.setAttribute("aria-valuenow", String(pct));
    $("ghost-1").style.display = remaining > 1 ? "" : "none";
    $("ghost-2").style.display = remaining > 2 ? "" : "none";
    resetCardPosition();
    requestAnimationFrame(updateScrollMoreHint);
  }

  function flip() {
    if (session.flipped) return unflip();
    session.flipped = true;
    $("card").classList.add("flipped");
    $("card-front").setAttribute("aria-hidden", "true");
    $("card-back").setAttribute("aria-hidden", "false");
    const c = currentCard();
    if (c) $("card").setAttribute("aria-label", `Answer: ${c.title}. ${session.browse ? "" : "Rate how well you knew it."}`);
    haptic(10);
    if (!session.browse) {
      const ivls = FSRS.previewIntervals(store.cardState[currentCard().id] || null);
      for (let g = 1; g <= 4; g++) $("ivl-" + g).textContent = ivls[g];
      $("grade-row").classList.remove("hidden");
      $("flip-hint").classList.add("hidden");
    }
    requestAnimationFrame(updateScrollMoreHint);
  }

  function unflip() {
    session.flipped = false;
    $("card").classList.remove("flipped");
    $("card-back").setAttribute("aria-hidden", "true");
    $("card-front").setAttribute("aria-hidden", "false");
    const c = currentCard();
    if (c) $("card").setAttribute("aria-label", `${c.type} card, ${c.tier}: ${c.title}. Front showing. Double-tap to flip.`);
    haptic(10);
    if (!session.browse) {
      $("grade-row").classList.add("hidden");
      $("flip-hint").classList.remove("hidden");
    }
    requestAnimationFrame(updateScrollMoreHint);
  }

  function grade(g) {
    if (!session) return;
    const card = currentCard();
    if (!session.browse) {
      const isNew = !store.cardState[card.id];
      // snapshot for undo (before any mutation)
      session.history.push({
        index: session.index,
        cardId: card.id,
        prevState: isNew ? null : JSON.parse(JSON.stringify(store.cardState[card.id])),
        wasNew: isNew,
        grade: g,
        prevStreak: { ...store.streak },
        prevIntroduced: { ...store.introduced },
        prevLastMilestone: store.lastMilestone,
      });
      store.cardState[card.id] = FSRS.review(store.cardState[card.id] || null, g);
      store.reviewLog.push({ cardId: card.id, ts: Date.now(), grade: g });
      if (isNew) store.introduced.count += 1;
      bumpStreak();
      if (g === 1) {
        session.againCount += 1;
        const reinsert = Math.min(session.index + 3, session.queue.length);
        session.queue.splice(reinsert, 0, card.id);
        session.history[session.history.length - 1].reinsertAt = reinsert;
      }
      session.doneCount += 1;
      save();
      updateUndoButton();
    }
    haptic(g === 1 ? [10, 40, 10] : 10);
    animateOut(g >= 3 ? 1 : -1, () => { session.index += 1; showCard(); });
  }

  // Undo the last grade — everyone mis-swipes; reversing FSRS state is the
  // difference between a toy and something you trust with your history.
  function undoGrade() {
    if (!session || session.browse || !session.history.length) return;
    const h = session.history.pop();
    if (typeof h.reinsertAt === "number") session.queue.splice(h.reinsertAt, 1);
    if (h.wasNew) delete store.cardState[h.cardId];
    else store.cardState[h.cardId] = h.prevState;
    store.reviewLog.pop();
    store.streak = h.prevStreak;
    store.introduced = h.prevIntroduced;
    store.lastMilestone = h.prevLastMilestone;
    session.doneCount = Math.max(0, session.doneCount - 1);
    if (h.grade === 1) session.againCount = Math.max(0, session.againCount - 1);
    session.index = h.index;
    save();
    haptic(8);
    // re-show the card already flipped to its answer, so the grades are right there
    showCard();
    flip();
    updateUndoButton();
  }
  function updateUndoButton() {
    const btn = $("btn-undo");
    if (!btn) return;
    btn.classList.toggle("hidden", !(session && !session.browse && session.history.length));
  }

  function nextBrowse(dir) {
    animateOut(dir, () => {
      session.index += 1;
      if (session.index >= session.queue.length) return endSession(false);
      showCard();
    });
  }

  function endSession(completed) {
    if (session && !session.browse && completed && session.doneCount > 0) {
      const mins = Math.max((Date.now() - session.startTs) / 60000, 0.01);
      const rate = (session.doneCount / mins).toFixed(1);
      const milestone = STREAK_MILESTONES.includes(store.streak.count) && store.lastMilestone !== store.streak.count;
      if (milestone) { store.lastMilestone = store.streak.count; save(); }
      if (window.track) track("session-complete");
      $("done-title").textContent = milestone ? `${store.streak.count}-day streak! 🔥` : "Session complete";
      $("done-sub").textContent =
        `${session.doneCount} reviews in ${mins < 1 ? Math.round(mins * 60) + "s" : mins.toFixed(1) + " min"}` +
        ` · ${rate} cards/min · ${session.againCount} to relearn` +
        (milestone ? " · consistency is the whole game" : ` · streak ${store.streak.count} 🔥`);
      $("session-done").classList.remove("hidden");
      haptic(milestone ? [15, 40, 15, 40, 30] : [10, 30, 10]);
    } else {
      $("review-overlay").classList.add("hidden");
    }
    session = null;
    renderToday();
  }
  $("btn-undo").addEventListener("click", undoGrade);
  $("btn-done-close").addEventListener("click", () => {
    $("session-done").classList.add("hidden");
    $("review-overlay").classList.add("hidden");
    renderToday();
  });
  $("btn-end-session").addEventListener("click", () => endSession(false));

  // ---------- gestures (PRD §5.3) ----------
  const holder = $("card-holder");
  let drag = null;
  function resetCardPosition() {
    holder.style.transition = "none";
    holder.style.transform = "";
    $("hint-left").style.opacity = 0;
    $("hint-right").style.opacity = 0;
    $("hint-up").style.opacity = 0;
  }
  function animateOut(dir, cb) {
    if (reduceMotion.matches) { resetCardPosition(); cb(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; holder.removeEventListener("transitionend", finish); resetCardPosition(); cb(); };
    holder.style.transition = "transform 0.25s ease-in";
    holder.style.transform = `translateX(${dir * 520}px) rotate(${dir * 16}deg)`;
    holder.addEventListener("transitionend", finish);
    setTimeout(finish, 320); // fallback if transitionend is missed (backgrounded tab)
  }

  // Native image drag-and-drop hijacks the pointer stream (pointercancel mid-swipe)
  // when a drag starts on a diagram — kill it so card gestures always win.
  holder.addEventListener("dragstart", (e) => e.preventDefault());
  // Android Chrome long-press on an <img> pops the image context menu, colliding
  // with the app's long-press-to-bookmark; the card owns its gestures.
  holder.addEventListener("contextmenu", (e) => e.preventDefault());

  let longPressTimer = null;
  holder.addEventListener("pointerdown", (e) => {
    if (!session) return;
    drag = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, t0: Date.now(), target: e.target };
    holder.setPointerCapture(e.pointerId);
    holder.style.transition = "none";
    longPressTimer = setTimeout(() => {
      if (drag && Math.abs(drag.dx) < 8 && Math.abs(drag.dy) < 8) {
        const card = currentCard();
        store.bookmarks[card.id] = !store.bookmarks[card.id];
        if (!store.bookmarks[card.id]) delete store.bookmarks[card.id];
        save();
        toast(store.bookmarks[card.id] ? "Bookmarked ✦" : "Bookmark removed");
        haptic(20);
        drag = null;
      }
    }, 550);
  });
  holder.addEventListener("pointermove", (e) => {
    if (!drag || !session) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
    // Scroll long card faces in JS (touch-action:none means no native scroll, but
    // we keep it that way so the swipe gestures stay reliable). Decide scroll-vs-
    // swipe ONCE, after the finger clears a slop radius: the first pointermove
    // arrives after ~1px of travel, and classifying on it locked every drag into
    // swipe mode — overflowing faces (long answers, diagrams) never scrolled.
    const face = session.flipped ? $("card-back") : $("card-front");
    if (!drag.grading && !drag.scrolling) {
      if (Math.hypot(drag.dx, drag.dy) < 12) return; // undecided inside the slop radius
      clearTimeout(longPressTimer);
      const canScroll = face && face.scrollHeight > face.clientHeight + 2;
      if (canScroll && Math.abs(drag.dy) > Math.abs(drag.dx)) {
        drag.scrolling = true;
        drag.lastY = e.clientY; // scroll from here — don't jump by the slop distance
        return;
      }
      drag.grading = true;
    }
    if (drag.scrolling) {
      face.scrollTop -= e.clientY - drag.lastY;
      drag.lastY = e.clientY;
      updateScrollMoreHint();
      return;
    }
    const dx = drag.dx;
    holder.style.transform = `translate(${dx}px, ${Math.min(0, drag.dy) * 0.5}px) rotate(${dx / 28}deg)`;
    if (!session.browse) {
      $("hint-right").style.opacity = Math.min(1, Math.max(0, drag.dx - 30) / 70);
      $("hint-left").style.opacity = Math.min(1, Math.max(0, -drag.dx - 30) / 70);
    }
    $("hint-up").style.opacity = Math.min(1, Math.max(0, -drag.dy - 30) / 50);
  });
  holder.addEventListener("pointerup", () => {
    if (!drag || !session) return;
    clearTimeout(longPressTimer);
    if (drag.scrolling) { drag = null; return; } // was scrolling the face, not a swipe
    const { dx, dy, t0, target } = drag;
    const dt = Math.max(1, Date.now() - t0);
    const vx = dx / dt; // px/ms — lets a fast flick commit even if short (native feel)
    const isTap = Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 400;
    const closest = (sel) => (target && target.closest ? target.closest(sel) : null);
    drag = null;
    if (isTap) {
      resetCardPosition();
      if (session.flipped && closest(".card-diagram")) { openViewer(closest(".card-diagram").dataset.card); return; }
      if (session.flipped && closest(".card-flag")) { openFeedback(currentCard()); return; }
      if (session.flipped && closest(".card-why-btn")) { openSheet(); return; }
      flip();
      return;
    }
    // swipe up = why — but only when the card fits (nothing to scroll). Scrollable
    // cards use vertical drags to scroll; their visible "Why & follow-ups" button
    // opens the sheet instead, so the two gestures never fight.
    const face = session.flipped ? $("card-back") : $("card-front");
    const faceScrollable = face && face.scrollHeight > face.clientHeight + 2;
    if (dy < -80 && Math.abs(dx) < 80 && !faceScrollable) { resetCardPosition(); openSheet(); return; }
    if (Math.abs(dx) > 100 || Math.abs(vx) > 0.5) {
      const dir = dx > 0 ? 1 : -1;
      if (session.browse) return nextBrowse(dir);
      stampAndGrade(dir);
      return;
    }
    holder.style.transition = "transform 0.25s cubic-bezier(0.2, 1.4, 0.4, 1)";
    holder.style.transform = "";
    $("hint-left").style.opacity = 0;
    $("hint-right").style.opacity = 0;
    $("hint-up").style.opacity = 0;
  });

  // pop the verdict stamp before the card flies off (delight; item 12)
  function stampAndGrade(dir) {
    const hint = $(dir > 0 ? "hint-right" : "hint-left");
    hint.style.opacity = 1;
    hint.classList.add("stamped");
    setTimeout(() => hint.classList.remove("stamped"), 260);
    grade(dir > 0 ? 3 : 1);
  }
  holder.addEventListener("pointercancel", () => { clearTimeout(longPressTimer); drag = null; resetCardPosition(); });

  document.querySelectorAll(".grade-pill").forEach((b) =>
    b.addEventListener("click", () => grade(parseInt(b.dataset.grade, 10)))
  );

  // keyboard (PRD §5.7: space = flip, 1–4 = grade)
  document.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (!$("diagram-viewer").classList.contains("hidden")) {
      if (e.key === "Escape") closeViewer();
      return;
    }
    if (!$("explain-sheet").classList.contains("hidden")) {
      if (e.key === "Escape") closeSheet();
      return;
    }
    if (!session) return;
    if (e.key === " ") { e.preventDefault(); flip(); }
    else if (["1", "2", "3", "4"].includes(e.key) && !session.browse) grade(parseInt(e.key, 10));
    else if (e.key === "ArrowUp") openSheet();
    else if (e.key === "ArrowRight" && session.browse) nextBrowse(1);
    else if (e.key === "Escape") endSession(false);
  });

  // ---------- explanation sheet (PRD §5.3 "show me why") ----------
  function openSheet() {
    const card = currentCard();
    if (!card) return;
    let html = `<h3>${card.title} <button class="card-flag sheet-flag" data-flag="${card.id}">⚑ flag</button></h3>` + mdToHtml(card.back) + diagramHtml(card, "sheet");
    if (card.explanation) html += "<h3>Why</h3>" + mdToHtml(card.explanation);
    if (card.followups && card.followups.length)
      html += "<h3>Interview follow-ups</h3><ul>" + card.followups.map((f) => "<li>" + mdToHtml(f).replace(/^<p>|<\/p>$/g, "") + "</li>").join("") + "</ul>";
    if (card.sources && card.sources.length)
      html += "<h3>Sources</h3><ul class=\"source-list\">" + card.sources.map((u) => `<li><a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a></li>`).join("") + "</ul>";
    $("sheet-body").innerHTML = html;
    const dia = $("sheet-body").querySelector(".card-diagram");
    if (dia) dia.addEventListener("click", () => openViewer(dia.dataset.card));
    const fl = $("sheet-body").querySelector(".sheet-flag");
    if (fl) fl.addEventListener("click", () => openFeedback(cardsById[fl.dataset.flag]));
    $("explain-sheet").classList.remove("hidden");
    $("sheet-backdrop").classList.remove("hidden");
    haptic(10);
  }
  function closeSheet() {
    const sheet = $("explain-sheet");
    sheet.style.transition = "";
    sheet.style.transform = "";
    sheet.classList.add("hidden");
    $("sheet-backdrop").classList.add("hidden");
  }
  $("sheet-backdrop").addEventListener("click", closeSheet);

  // Native drag-to-dismiss on bottom sheets (item 5). Only starts a drag when the
  // sheet body is scrolled to top, so content still scrolls normally.
  function makeSheetDismissible(sheetId, onClose) {
    const sheet = $(sheetId);
    const body = sheet.querySelector(".sheet-body, .date-sheet-body");
    let sd = null;
    sheet.addEventListener("pointerdown", (e) => {
      if (body && body.scrollTop > 2 && !e.target.closest(".sheet-grip")) return;
      sd = { y0: e.clientY, dy: 0 };
      sheet.style.transition = "none";
    });
    sheet.addEventListener("pointermove", (e) => {
      if (!sd) return;
      sd.dy = Math.max(0, e.clientY - sd.y0);
      if (sd.dy > 0) sheet.style.transform = `translateY(${sd.dy}px)`;
    });
    // On touch, the browser grabs a vertical drag for native scrolling and fires
    // pointercancel, killing the dismiss gesture. preventDefault here (non-passive)
    // keeps downward drags that started at the top; upward drags fall through so
    // the sheet body still scrolls natively.
    sheet.addEventListener("touchmove", (e) => {
      if (sd && e.touches[0].clientY - sd.y0 > 0) e.preventDefault();
    }, { passive: false });
    const end = () => {
      if (!sd) return;
      const dy = sd.dy; sd = null;
      sheet.style.transition = "transform 0.25s cubic-bezier(0.2,0.9,0.3,1)";
      if (dy > 110) { sheet.style.transform = "translateY(100%)"; setTimeout(onClose, 220); }
      else sheet.style.transform = "";
    };
    sheet.addEventListener("pointerup", end);
    sheet.addEventListener("pointercancel", end);
  }
  makeSheetDismissible("explain-sheet", closeSheet);

  // ---------- diagram viewer (PRD §5.4: pinch-to-zoom, pan) ----------
  const viewer = $("diagram-viewer");
  const viewerImg = $("viewer-img");
  const vc = $("viewer-canvas");
  let vz = { scale: 1, tx: 0, ty: 0 };
  const pointers = new Map();
  let pinchStart = null;

  function applyViewer() {
    viewerImg.style.transform = `translate(${vz.tx}px, ${vz.ty}px) scale(${vz.scale})`;
  }
  function openViewer(cardId) {
    const card = cardsById[cardId];
    if (!card || !card.diagram) return;
    viewerImg.src = card.diagram.dark;
    viewerImg.alt = card.diagram.alt;
    vz = { scale: 1, tx: 0, ty: 0 };
    applyViewer();
    viewer.classList.remove("hidden");
    haptic(8);
  }
  function closeViewer() { viewer.classList.add("hidden"); pointers.clear(); pinchStart = null; }
  $("btn-close-viewer").addEventListener("click", closeViewer);

  vc.addEventListener("dragstart", (e) => e.preventDefault());
  vc.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press mid-pan on Android
  vc.addEventListener("pointerdown", (e) => {
    vc.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: vz.scale };
    }
  });
  vc.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && !pinchStart) {
      vz.tx += e.clientX - prev.x;
      vz.ty += e.clientY - prev.y;
      applyViewer();
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      vz.scale = Math.min(6, Math.max(0.5, (pinchStart.scale * dist) / pinchStart.dist));
      applyViewer();
    }
  });
  const viewerUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
  };
  vc.addEventListener("pointerup", viewerUp);
  vc.addEventListener("pointercancel", viewerUp);
  vc.addEventListener("wheel", (e) => {
    e.preventDefault();
    vz.scale = Math.min(6, Math.max(0.5, vz.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    applyViewer();
  }, { passive: false });
  vc.addEventListener("dblclick", () => { vz = { scale: 1, tx: 0, ty: 0 }; applyViewer(); });

  // ---------- interview date sheet ----------
  function openDateSheet() {
    $("interview-date-input").value = store.interviewDate || "";
    $("date-sheet").classList.remove("hidden");
    $("date-backdrop").classList.remove("hidden");
  }
  function closeDateSheet() {
    $("date-sheet").classList.add("hidden");
    $("date-backdrop").classList.add("hidden");
  }
  $("btn-interview-date").addEventListener("click", openDateSheet);
  $("date-backdrop").addEventListener("click", closeDateSheet);
  $("btn-save-date").addEventListener("click", () => {
    const v = $("interview-date-input").value;
    store.interviewDate = v || null;
    save(); closeDateSheet(); renderToday();
    if (v) toast(`Crunch mode: ${effectiveNewPerDay()} new cards/day 🎯`);
  });
  $("btn-clear-date").addEventListener("click", () => {
    store.interviewDate = null;
    save(); closeDateSheet(); renderToday();
  });

  // ---------- quiz (PRD §5.5, formats §6.3) ----------
  let quiz = null; // {deck, questions, index, answers: [...]}
  const FORMAT_LABEL = {
    "single-select": "", "best-next-question": "best next question",
    order: "order the bottleneck", estimate: "estimate",
  };

  function startQuiz(deckId) {
    const q = CONTENT.quizzes.find((x) => x.deck === deckId);
    if (!q) return;
    quiz = { deck: deckId, questions: q.questions, index: 0, answers: [] };
    $("quiz-overlay").classList.remove("hidden");
    if (window.track) track("quiz-start");
    renderQuizQuestion();
  }
  $("btn-end-quiz").addEventListener("click", () => { quiz = null; $("quiz-overlay").classList.add("hidden"); });

  function quizNextButton(label) {
    const next = document.createElement("button");
    next.className = "btn-primary quiz-next";
    next.textContent = label;
    next.addEventListener("click", () => {
      quiz.index += 1;
      quiz.index < quiz.questions.length ? renderQuizQuestion() : renderQuizResults();
    });
    return next;
  }
  function finishQuestion(correct) {
    haptic(correct ? 10 : [10, 40, 10]);
    $("quiz-body").appendChild(
      quizNextButton(quiz.index + 1 < quiz.questions.length ? "Next" : "See results")
    );
  }

  function renderQuizQuestion() {
    const q = quiz.questions[quiz.index];
    $("quiz-count").textContent = `${quiz.index + 1}/${quiz.questions.length}`;
    $("quiz-progress-fill").style.width = (quiz.index / quiz.questions.length) * 100 + "%";
    const body = $("quiz-body");
    const chip = FORMAT_LABEL[q.format] ? `<span class="quiz-format-chip">${FORMAT_LABEL[q.format]}</span>` : "";
    body.innerHTML = `${chip}<div class="quiz-prompt">${mdToHtml(q.prompt)}</div>`;
    if (q.format === "order") renderOrderQuestion(q, body);
    else if (q.format === "estimate") renderEstimateQuestion(q, body);
    else renderSelectQuestion(q, body);
  }

  // --- single-select / best-next-question ---
  function renderSelectQuestion(q, body) {
    q.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "quiz-option";
      btn.innerHTML = mdToHtml(opt.text);
      btn.addEventListener("click", () => {
        const correct = !!opt.correct;
        quiz.answers.push({ format: q.format, correct, chosenIdx: i });
        body.querySelectorAll(".quiz-option").forEach((b, j) => {
          b.disabled = true;
          const o = q.options[j];
          if (o.correct) b.classList.add("correct");
          if (j === i && !o.correct) b.classList.add("wrong");
          if (j === i || o.correct) b.innerHTML += `<div class="quiz-why">${mdToHtml(o.why)}</div>`;
        });
        finishQuestion(correct);
      });
      body.appendChild(btn);
    });
  }

  // --- order-the-bottleneck: items authored in correct order, shown shuffled ---
  function renderOrderQuestion(q, body) {
    const n = q.items.length;
    let displayOrder = q.items.map((_, i) => i);
    do {
      for (let i = displayOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [displayOrder[i], displayOrder[j]] = [displayOrder[j], displayOrder[i]];
      }
    } while (displayOrder.every((v, i) => v === i)); // never show pre-solved
    const picks = []; // display indices in pick order

    const wrap = document.createElement("div");
    body.appendChild(wrap);
    const submit = document.createElement("button");
    submit.className = "btn-primary quiz-next";
    submit.textContent = "Check order";
    submit.disabled = true;

    function renderItems() {
      wrap.innerHTML = "";
      displayOrder.forEach((origIdx, di) => {
        const btn = document.createElement("button");
        const pickPos = picks.indexOf(di);
        btn.className = "order-item" + (pickPos >= 0 ? " picked" : "");
        btn.innerHTML = `<span class="order-num">${pickPos >= 0 ? pickPos + 1 : "·"}</span><span>${mdToHtml(q.items[origIdx].text)}</span>`;
        btn.addEventListener("click", () => {
          const at = picks.indexOf(di);
          if (at >= 0) picks.splice(at, 1);
          else picks.push(di);
          submit.disabled = picks.length !== n;
          haptic(6);
          renderItems();
        });
        wrap.appendChild(btn);
      });
    }
    renderItems();

    submit.addEventListener("click", () => {
      const userOrder = picks.map((di) => displayOrder[di]); // original indices in user order
      const correct = userOrder.every((v, i) => v === i);
      quiz.answers.push({ format: "order", correct, userOrder });
      // re-render in the CORRECT order, marking what the user got right per position
      wrap.innerHTML = "";
      q.items.forEach((item, pos) => {
        const div = document.createElement("button");
        div.disabled = true;
        div.className = "order-item " + (userOrder[pos] === pos ? "correct" : "wrong");
        div.innerHTML = `<span class="order-num">${pos + 1}</span><span>${mdToHtml(item.text)}<div class="quiz-why">${mdToHtml(item.why)}</div></span>`;
        wrap.appendChild(div);
      });
      submit.remove();
      finishQuestion(correct);
    });
    body.appendChild(submit);
  }

  // --- estimation with tolerance bands ---
  function renderEstimateQuestion(q, body) {
    const wrap = document.createElement("div");
    wrap.className = "estimate-wrap";
    const input = document.createElement("input");
    input.className = "estimate-input";
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "your estimate";
    const unit = document.createElement("span");
    unit.className = "estimate-unit";
    unit.textContent = q.answer.unit;
    wrap.appendChild(input); wrap.appendChild(unit);
    body.appendChild(wrap);

    const submit = document.createElement("button");
    submit.className = "btn-primary quiz-next";
    submit.textContent = "Check estimate";
    submit.addEventListener("click", () => {
      const val = parseFloat(input.value.replace(/[,\s_]/g, ""));
      if (isNaN(val)) { input.focus(); return; }
      const inBand = val >= q.answer.lo && val <= q.answer.hi;
      quiz.answers.push({ format: "estimate", correct: inBand, value: val });
      input.disabled = true;
      input.style.borderColor = inBand ? "var(--good)" : "var(--again)";
      const band = document.createElement("div");
      band.className = "estimate-band";
      band.innerHTML =
        `Accepted band: <b>${q.answer.lo.toLocaleString()}–${q.answer.hi.toLocaleString()} ${q.answer.unit}</b> · ` +
        `you said <b class="${inBand ? "in" : "out"}">${val.toLocaleString()} ${q.answer.unit}</b> — ${inBand ? "within the band ✓" : "outside the band ✗"}` +
        `<div class="quiz-why">${mdToHtml(q.why)}</div>`;
      body.insertBefore(band, submit);
      submit.remove();
      finishQuestion(inBand);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
    body.appendChild(submit);
    setTimeout(() => input.focus(), 50);
  }

  function answerSummaryHtml(q, a) {
    if (a.format === "order") {
      const seq = a.userOrder.map((v) => v + 1).join(" → ");
      return `<div class="${a.correct ? "verdict-right" : "verdict-wrong"}">${a.correct ? "✓ correct order" : "✗ your order: " + seq}</div>` +
        (!a.correct ? `<div class="why-line"><b>Correct:</b> ${q.items.map((it) => it.text).join(" → ")}</div>` : "");
    }
    if (a.format === "estimate") {
      return `<div class="${a.correct ? "verdict-right" : "verdict-wrong"}">${a.correct ? "✓" : "✗"} ${a.value.toLocaleString()} ${q.answer.unit}</div>` +
        `<div class="why-line"><b>Band:</b> ${q.answer.lo.toLocaleString()}–${q.answer.hi.toLocaleString()} ${q.answer.unit} — ${mdToHtml(q.why)}</div>`;
    }
    const chosen = q.options[a.chosenIdx];
    const correct = q.options.find((o) => o.correct);
    return `<div class="${a.correct ? "verdict-right" : "verdict-wrong"}">${a.correct ? "✓ " : "✗ "}${mdToHtml(chosen.text)}</div>` +
      (!a.correct
        ? `<div class="why-line"><b>Why not:</b> ${mdToHtml(chosen.why)}</div><div class="why-line"><b>Answer:</b> ${mdToHtml(correct.text)} — ${mdToHtml(correct.why)}</div>`
        : `<div class="why-line">${mdToHtml(chosen.why)}</div>`);
  }

  function renderQuizResults() {
    $("quiz-progress-fill").style.width = "100%";
    const score = quiz.answers.filter((a) => a.correct).length;
    // Core loop: wrong answers inject the underlying card into the review queue (PRD §5.5)
    const injected = [];
    quiz.questions.forEach((q, i) => {
      if (!quiz.answers[i].correct && q.card_id && Levels.meetsMinimumTier(cardsById[q.card_id], store.minimumTier)) {
        const st = store.cardState[q.card_id];
        if (st) { st.due = Math.min(st.due, Date.now()); }
        else {
          store.cardState[q.card_id] = FSRS.review(null, 1);
          store.introduced.count += 1;
        }
        if (!injected.includes(cardsById[q.card_id].title)) injected.push(cardsById[q.card_id].title);
      }
    });
    store.quizLog.push({ deck: quiz.deck, ts: Date.now(), score, total: quiz.questions.length });
    save();
    if (window.track) track("quiz-complete");

    const body = $("quiz-body");
    body.innerHTML = `
      <div class="quiz-result-hero">
        <div class="quiz-score">${score}/${quiz.questions.length}</div>
        <div class="quiz-score-label">${score === quiz.questions.length ? "Clean sweep." : score >= Math.ceil(quiz.questions.length * 0.6) ? "Solid — review the misses below." : "The gaps found you. That's the point."}</div>
      </div>`;
    if (injected.length) {
      body.innerHTML += `<div class="quiz-inject-note">↻ ${injected.length} card${injected.length > 1 ? "s" : ""} added to your review queue: <b>${injected.join(", ")}</b></div>`;
    }
    quiz.questions.forEach((q, i) => {
      body.innerHTML += `
        <div class="quiz-review-item">
          <div class="q">${mdToHtml(q.prompt)}</div>
          ${answerSummaryHtml(q, quiz.answers[i])}
        </div>`;
    });
    const done = document.createElement("button");
    done.className = "btn-primary quiz-next";
    done.textContent = "Done";
    done.addEventListener("click", () => { quiz = null; $("quiz-overlay").classList.add("hidden"); renderToday(); });
    body.appendChild(done);
  }

  // ---------- top-level buttons ----------
  $("btn-start-review").addEventListener("click", () => startSession(buildQueue()));
  $("btn-quick-session").addEventListener("click", () => startSession(buildQueue().slice(0, 15)));
  $("btn-caught-up").addEventListener("click", () => { switchTab("library"); haptic(5); });
  $("btn-reset").addEventListener("click", () => {
    if (confirm("Reset all local review history?")) {
      localStorage.removeItem(STORE_KEY);
      store = load();
      renderProgress();
      renderToday();
      toast("Local data reset");
    }
  });
  $("btn-feedback").addEventListener("click", () => openFeedback(null));
  $("minimum-tier-select").addEventListener("change", (e) => {
    store.minimumTier = Levels.normalizeMinimumTier(e.target.value);
    save();
    renderToday();
    renderProgress();
    toast(`Today now shows ${store.minimumTier} and above`);
    if (window.track) track("minimum-tier-changed");
  });

  // ---------- backup / restore (localStorage is evictable — give testers a lifeboat) ----------
  $("btn-export").addEventListener("click", () => {
    const payload = { app: "paradigm", contentVersion: CONTENT.version, exportedAt: new Date().toISOString(), store };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `paradigm-backup-${dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Backup downloaded ✓");
  });
  $("btn-import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        const s = payload.store || payload; // accept raw store too
        if (!s || typeof s.cardState !== "object" || !Array.isArray(s.reviewLog)) {
          toast("Not a Paradigm backup file"); return;
        }
        if (!confirm(`Restore backup with ${s.reviewLog.length} reviews? This replaces current local data.`)) return;
        localStorage.setItem(STORE_KEY, JSON.stringify(s));
        store = load();
        renderToday(); renderProgress();
        toast("Backup restored ✓");
      } catch (err) {
        toast("Couldn't read that file");
      }
    };
    reader.readAsText(file);
  });

  // ---------- iOS "add to home screen" hint ----------
  // iOS Safari doesn't fire beforeinstallprompt, so a manual hint is the only way
  // to nudge installation — and installing is what makes the app compete with the
  // Instagram icon in a dead moment. Show once, only in iOS Safari, not already installed.
  (function () {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) && !window.MSStream;
    const isSafari = /^((?!chrome|crios|fxios|edgios).)*safari/i.test(ua);
    const standalone = window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (isIOS && isSafari && !standalone && !store.installHintDismissed) {
      const el = $("install-hint");
      el.classList.remove("hidden");
      $("install-hint-close").addEventListener("click", () => {
        el.classList.add("hidden");
        store.installHintDismissed = true;
        save();
      });
    }
  })();

  // ---------- onboarding (first launch) ----------
  if (!store.onboarded) {
    $("onboarding").classList.remove("hidden");
    $("btn-onboard-done").addEventListener("click", () => {
      const selected = document.querySelector('input[name="onboard-minimum-tier"]:checked');
      store.minimumTier = Levels.normalizeMinimumTier(selected && selected.value);
      store.onboarded = true;
      save();
      $("onboarding").classList.add("hidden");
      if (window.track) track("onboarding-complete");
      startSession(buildQueue().slice(0, 15));
    });
  }

  // ---------- PWA: service worker + content-pack update check (PRD §8.1) ----------
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register(`sw.js?v=${CONTENT.version}`).catch(() => {});
    fetch("data/manifest.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((m) => {
        if (m.version > CONTENT.version) {
          toast("New content pack available — reload to update", 4000);
        } else if (m.version === CONTENT.version && store.seenContentVersion !== m.version) {
          if (store.seenContentVersion > 0)
            toast(`Content updated: v${m.version} · ${m.cards} cards, ${m.decks} decks`, 3500);
          store.seenContentVersion = m.version;
          save();
        }
      })
      .catch(() => {});
  }

  renderToday();
})();
