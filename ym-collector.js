(() => {
  "use strict";

  // ====== LANGUAGE: "en" or "ru" ======
  const LANG = "en";

  const i18n = {
    en: {
      title: "YM Collector",
      startAuto: "Start auto-scroll",
      pauseAuto: "Pause (switch to manual)",
      resumeAuto: "Resume auto-scroll",
      finalize: "Finalize + download",
      dlTxt: "Download .txt",
      dlCsv: "Download .csv",
      idle: "Scroll manually or start auto-scroll",
      paused: "Paused. Scroll manually or resume.",
      finished: "Finished",
      scrolling: "Auto-scrolling...",
      collecting: "Collecting...",
      finalizing: "Finalizing...",
      waiting: "Waiting for batch...",
      done: "Done!",
      of: "of",
      noTotal: "total unknown",
      skipped: "skipped (unavailable)",
      mode: "Mode",
      auto: "AUTO",
      manual: "MANUAL",
    },
    ru: {
      title: "YM Collector",
      startAuto: "Запустить авто-скролл",
      pauseAuto: "Пауза (ручной режим)",
      resumeAuto: "Продолжить авто-скролл",
      finalize: "Завершить + скачать",
      dlTxt: "Скачать .txt",
      dlCsv: "Скачать .csv",
      idle: "Скролль вручную или запусти авто-скролл",
      paused: "Пауза. Скролль вручную или продолжи.",
      finished: "Готово",
      scrolling: "Авто-скролл...",
      collecting: "Собираю...",
      finalizing: "Финализация...",
      waiting: "Жду порцию...",
      done: "Готово!",
      of: "из",
      noTotal: "всего неизв.",
      skipped: "пропущено (недоступно)",
      mode: "Режим",
      auto: "АВТО",
      manual: "РУЧНОЙ",
    },
  };
  const t = i18n[LANG] || i18n.en;

  // ====== Config ======
  const CFG = {
    scrollStep: 400,
    waitAfterScroll: 600,
    waitForBatch: 2000,
    maxStaleRounds: 15,
    settlePasses: 5,
    settleTickMs: 400,
    debounceMs: 200,
  };

  // ====== State ======
  const tracks = new Map();
  let skippedCount = 0;
  let running = true;
  let autoScrolling = false;
  let expectedTotal = null;

  // ====== Selectors ======
  const SEL = {
    // Primary (2026 layout): CommonTrack rows inside the virtuoso list
    trackRow: "[class*='CommonTrack_root']",
    // Fallback: older layout / any virtuoso item that holds a track link
    trackRowAlt: [
      "[data-intersection-property-id^='tracks_track_']",
      "[data-index]",
    ],
    trackLink: "a[href*='/track/']",
    version: ["[class*='Meta_version']"],
    duration: "[class*='CommonControlsBar_root']",
    title: [
      "[class*='Meta_title__']",
      "[class*='Meta_title']",
      "a[href*='/track/']",
      "[class*='track__title']",
      "[class*='TrackTitle']",
    ],
    artist: [
      "[class*='Meta_artistCaption']",
      "[class*='Meta_artist'] a",
      "[class*='track__artists'] a",
      "[class*='TrackArtist'] a",
    ],
    // Unavailable/deleted track markers
    unavailable: [
      "[class*='Track_unavailable']",
      "[class*='track_disabled']",
      "[class*='Meta_disabled']",
    ],
    scroller: "[data-virtuoso-scroller='true']",
    totalCount: [
      "[class*='PageHeader_count']",
      "[class*='page-header__count']",
      "[class*='playlist__count']",
      "[class*='LibraryHead_count']",
    ],
    skeleton: [
      "[class*='Skeleton']",
      "[class*='skeleton']",
      "[class*='Loader']",
      "[class*='loader']",
    ],
  };

  // ====== Helpers ======
  const $ = (el, sel) => el.querySelector(sel);
  const $$ = (el, sel) => el.querySelectorAll(sel);
  const textOf = (el) => el ? el.textContent.trim() : "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const queryFirst = (el, selectors) => {
    for (const s of selectors) {
      const found = $(el, s);
      if (found) return found;
    }
    return null;
  };

  const queryAll = (el, selectors) => {
    for (const s of selectors) {
      const found = $$(el, s);
      if (found.length > 0) return found;
    }
    return [];
  };

  // ====== Read expected total from page ======
  const readExpectedTotal = () => {
    // Direct selectors
    for (const sel of SEL.totalCount) {
      const el = document.querySelector(sel);
      if (el) {
        const num = parseInt(el.textContent.replace(/\D/g, ""), 10);
        if (num > 0) { expectedTotal = num; return; }
      }
    }
    // Fallback: regex on header
    const header = document.querySelector("[class*='PageHeader']") ||
                   document.querySelector("[class*='page-header']") ||
                   document.querySelector("[class*='LibraryHead']");
    if (header) {
      const match = header.textContent.match(/(\d[\d\s]*)\s*(треков|трека|трек|tracks?|songs?|liked)/i);
      if (match) {
        expectedTotal = parseInt(match[1].replace(/\s/g, ""), 10);
      }
    }
    // Fallback 2: look for any large number in the page title area
    if (!expectedTotal) {
      const allNums = document.body.textContent.match(/(\d{3,})\s*(треков|трека|трек|tracks?|songs?)/gi);
      if (allNums && allNums.length > 0) {
        const m = allNums[0].match(/(\d+)/);
        if (m) expectedTotal = parseInt(m[1], 10);
      }
    }
  };

  // ====== Check if loading ======
  const isLoading = () => {
    for (const sel of SEL.skeleton) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  };

  // ====== Check if row is unavailable ======
  const isUnavailable = (row) => {
    for (const sel of SEL.unavailable) {
      if (row.matches(sel) || row.querySelector(sel)) return true;
    }
    // Also check opacity/disabled style
    const style = window.getComputedStyle(row);
    if (parseFloat(style.opacity) < 0.5) return true;
    return false;
  };

  // ====== Extract tracks from current DOM ======
  const extractTracks = () => {
    // Primary: rows with data-intersection-property-id
    let rows = document.querySelectorAll(SEL.trackRow);

    // Fallback: try alt selectors if primary finds nothing
    if (rows.length === 0) {
      for (const sel of SEL.trackRowAlt) {
        rows = document.querySelectorAll(sel);
        if (rows.length > 0) break;
      }
    }

    rows.forEach((row) => {
      // ID from the track link: /album/<albumId>/track/<trackId>
      const link = row.querySelector(SEL.trackLink);
      const href = link ? link.getAttribute("href") || "" : "";
      const m = href.match(/(?:\/album\/(\d+))?\/track\/(\d+)/);
      const rawId = row.getAttribute("data-intersection-property-id") || "";
      let id = m ? m[2] : rawId.replace("tracks_track_", "");
      const albumId = m && m[1] ? m[1] : "";

      if (id && tracks.has(id)) {
        // Opacity can be transient (fade-in) — clear a stale unavailable flag
        const seen = tracks.get(id);
        if (seen.unavailable && !isUnavailable(row)) { seen.unavailable = false; skippedCount--; }
        return;
      }

      const titleEl = queryFirst(row, SEL.title);
      let title = textOf(titleEl);
      if (!title) {
        // Row exists but no title — might be loading or broken
        console.log("[YM Collector] Row without title, id:", id,
          "classes:", String(row.className).substring(0, 80));
        return;
      }

      const version = textOf(queryFirst(row, SEL.version));
      if (version && title.endsWith(version) && title !== version) {
        title = title.slice(0, -version.length).trim();
      }
      const artistEls = queryAll(row, SEL.artist);
      const artists = [...new Set(Array.from(artistEls).map(textOf).filter(Boolean))]
        .join(", ");

      // Rows without a track link (e.g. unavailable) — key by artist + title
      if (!id) {
        id = `noid:${artists} - ${title}${version ? ` (${version})` : ""}`;
        if (tracks.has(id)) {
          const seen = tracks.get(id);
          if (seen.unavailable && !isUnavailable(row)) { seen.unavailable = false; skippedCount--; }
          return;
        }
      }
      const durEl = row.querySelector(SEL.duration);
      const durMatch = durEl ? durEl.textContent.match(/(\d+):(\d{2})(?::(\d{2}))?/) : null;
      const duration = durMatch
        ? (durMatch[3]
            ? (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3])
            : (+durMatch[1]) * 60 + (+durMatch[2]))
        : null;

      // Unavailable on YM is still a liked track — keep it, just flag it
      const unavailable = isUnavailable(row);
      if (unavailable) skippedCount++;

      tracks.set(id, {
        id,
        albumId,
        title,
        version,
        artists: artists || "Unknown",
        duration,
        url: albumId ? `https://music.yandex.ru/album/${albumId}/track/${id}` : null,
        unavailable,
      });
    });
  };

  // ====== Scroller ======
  const getScroller = () =>
    document.querySelector(SEL.scroller) ||
    document.scrollingElement ||
    document.documentElement;

  // ====== Safe DOM builder ======
  const h = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") el.className = v;
      else if (k === "textContent") el.textContent = v;
      else if (k.startsWith("on")) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const child of children) {
      if (typeof child === "string") el.appendChild(document.createTextNode(child));
      else el.appendChild(child);
    }
    return el;
  };

  // ====== Format output (all collected, incl. unavailable on YM) ======
  const availableTracks = () => Array.from(tracks.values());

  const fullTitle = (tr) => (tr.version ? `${tr.title} (${tr.version})` : tr.title);

  const formatTxt = () =>
    availableTracks()
      .map((tr) => `${tr.artists} - ${fullTitle(tr)}`)
      .join("\n");

  const formatCsv = () =>
    "Artist,Title\n" +
    availableTracks()
      .map((tr) => `"${tr.artists.replace(/"/g, '""')}","${fullTitle(tr).replace(/"/g, '""')}"`)
      .join("\n");

  const formatJson = () =>
    JSON.stringify({
      source: "yandex",
      page: location.href,
      exported_at: new Date().toISOString(),
      tracks: availableTracks().map((tr) => ({
        id: tr.id,
        album_id: tr.albumId,
        artist: tr.artists,
        title: fullTitle(tr),
        duration: tr.duration,
        url: tr.url,
        unavailable: tr.unavailable,
      })),
    }, null, 2);

  // ====== Download ======
  const downloadFile = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ====== Status string ======
  const statusStr = (msg) => {
    const available = availableTracks().length;
    const total = expectedTotal
      ? ` ${t.of} ~${expectedTotal}`
      : ` (${t.noTotal})`;
    const skipped = skippedCount > 0
      ? ` | ${skippedCount} ${t.skipped}`
      : "";
    return `${msg} ${available}${total}${skipped}`;
  };

  // ====== Auto-scroll ======
  const startAutoScroll = async () => {
    if (autoScrolling) return;
    autoScrolling = true;

    readExpectedTotal();
    const el = getScroller();
    let staleRounds = 0;

    renderPanel(statusStr(t.scrolling));

    while (running && autoScrolling) {
      const sizeBefore = tracks.size;
      const scrollBefore = el.scrollTop;

      // 1. Scroll
      el.scrollBy({ top: CFG.scrollStep, behavior: "smooth" });

      // 2. Wait for DOM to render
      await sleep(CFG.waitAfterScroll);

      // 3. Wait if loading indicator is visible
      let loadWaits = 0;
      while (isLoading() && loadWaits < 15) {
        await sleep(300);
        loadWaits++;
      }

      // 4. Extract
      extractTracks();

      // 5. Check progress
      const gotNew = tracks.size > sizeBefore;
      const scrollMoved = Math.abs(el.scrollTop - scrollBefore) > 2;

      if (gotNew) {
        staleRounds = 0;
        renderPanel(statusStr(t.scrolling));
      } else {
        staleRounds++;
        renderPanel(statusStr(t.waiting));

        // Wait longer for server batch
        await sleep(CFG.waitForBatch);
        extractTracks();

        if (tracks.size > sizeBefore) {
          staleRounds = 0;
          renderPanel(statusStr(t.scrolling));
        }
      }

      // 6. Done check: reached expected total
      if (expectedTotal && tracks.size >= expectedTotal) {
        console.log("[YM Collector] Reached expected total:", expectedTotal);
        break;
      }

      // 7. Stuck check
      if (!scrollMoved && staleRounds >= CFG.maxStaleRounds) {
        console.log("[YM Collector] Stuck for", staleRounds, "rounds.",
          "Collected:", tracks.size, "Expected:", expectedTotal || "?");
        break;
      }

      // 8. If scroll stuck but total not reached — try jump to bottom
      if (!scrollMoved && staleRounds >= 3) {
        el.scrollTop = el.scrollHeight;
        await sleep(CFG.waitForBatch);
        extractTracks();
      }
    }

    // If we're still running (not manually paused), finalize
    if (running && !autoScrolling) {
      // Paused by user — don't finalize
      renderPanel(statusStr(t.paused));
    } else if (running) {
      autoScrolling = false;
      await settleCapture();
    }
  };

  const pauseAutoScroll = () => {
    autoScrolling = false;
    renderPanel(statusStr(t.paused));
  };

  // ====== Settle ======
  const settleCapture = async () => {
    autoScrolling = false;
    renderPanel(statusStr(t.finalizing));

    for (let pass = 0; pass < CFG.settlePasses; pass++) {
      const before = tracks.size;
      extractTracks();
      renderPanel(statusStr(t.finalizing));
      if (tracks.size === before && pass > 0) break;
      await sleep(CFG.settleTickMs);
    }

    running = false;

    const available = availableTracks().length;
    console.log("[YM Collector] Finished.", available, "available tracks.",
      skippedCount, "unavailable.", "Expected:", expectedTotal || "?");

    renderPanel(statusStr(t.done));
  };

  // ====== UI ======
  const injectStyles = () => {
    if (document.getElementById("ym-col-css")) return;
    const style = document.createElement("style");
    style.id = "ym-col-css";
    style.textContent = `
      #ym-col {
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        width: 300px; background: #111; border: 1px solid #333;
        border-radius: 10px; padding: 16px;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
        color: #aaa; box-shadow: 0 8px 32px rgba(0,0,0,.7);
      }
      #ym-col .hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
      #ym-col .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: #555; }
      #ym-col .mode { font-size: 9px; padding: 2px 6px; border-radius: 4px; }
      #ym-col .mode-auto { background: #1a2e05; color: #a3e635; }
      #ym-col .mode-manual { background: #2e2005; color: #e6a33e; }
      #ym-col .dot { width: 8px; height: 8px; border-radius: 50%; background: #333; }
      #ym-col .dot.on { background: #a3e635; box-shadow: 0 0 8px rgba(163,230,53,.5); }
      #ym-col .cnt { font-size: 32px; color: #f5f5f5; margin: 4px 0; }
      #ym-col .tot { font-size: 11px; color: #555; margin-bottom: 4px; }
      #ym-col .bar { height: 3px; background: #222; border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
      #ym-col .bar-fill { height: 100%; background: #a3e635; border-radius: 2px; transition: width .3s; }
      #ym-col .sts { font-size: 11px; color: #555; min-height: 16px; margin: 4px 0 10px; word-break: break-word; }
      #ym-col button {
        display: block; width: 100%; padding: 8px; margin-top: 6px;
        background: transparent; border: 1px solid #333; border-radius: 6px;
        color: #ccc; font: inherit; cursor: pointer; text-align: left;
      }
      #ym-col button:hover { background: #1a1a1a; border-color: #555; color: #fff; }
      #ym-col button.pri { border-color: #a3e635; color: #a3e635; }
      #ym-col button.pri:hover { background: rgba(163,230,53,.08); }
      #ym-col button.warn { border-color: #e6a33e; color: #e6a33e; }
      #ym-col button.warn:hover { background: rgba(230,163,62,.08); }
    `;
    document.head.appendChild(style);
  };

  const renderPanel = (status = "") => {
    let panel = document.getElementById("ym-col");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "ym-col";
      document.body.appendChild(panel);
    }

    while (panel.firstChild) panel.removeChild(panel.firstChild);

    const statusText = status || (running ? t.idle : t.finished);
    const available = availableTracks().length;

    // Header row: title + mode badge + dot
    const modeLabel = autoScrolling ? t.auto : t.manual;
    const modeClass = autoScrolling ? "mode mode-auto" : "mode mode-manual";

    panel.appendChild(h("div", { className: "hdr" }, [
      h("div", { className: "lbl", textContent: t.title }),
      h("span", { className: modeClass, textContent: modeLabel }),
      h("div", { className: running ? "dot on" : "dot" }),
    ]));

    // Count
    panel.appendChild(h("div", { className: "cnt", textContent: String(available) }));

    // Total + progress bar
    if (expectedTotal) {
      const pct = Math.min(100, Math.round((tracks.size / expectedTotal) * 100));
      const info = `${t.of} ~${expectedTotal} (${pct}%)`;
      const extra = skippedCount > 0 ? ` | ${skippedCount} ${t.skipped}` : "";
      panel.appendChild(h("div", { className: "tot", textContent: info + extra }));
      const barFill = h("div", { className: "bar-fill" });
      barFill.style.width = pct + "%";
      panel.appendChild(h("div", { className: "bar" }, [barFill]));
    } else if (skippedCount > 0) {
      panel.appendChild(h("div", { className: "tot", textContent: `${skippedCount} ${t.skipped}` }));
    }

    // Status
    panel.appendChild(h("div", { className: "sts", textContent: statusText }));

    // Buttons
    if (running) {
      if (autoScrolling) {
        // While auto-scrolling: pause button
        const btnPause = h("button", { className: "warn", textContent: t.pauseAuto });
        btnPause.onclick = pauseAutoScroll;
        panel.appendChild(btnPause);
      } else {
        // Manual mode: start/resume auto-scroll
        const btnAuto = h("button", { className: "pri", textContent: tracks.size > 0 ? t.resumeAuto : t.startAuto });
        btnAuto.onclick = startAutoScroll;
        panel.appendChild(btnAuto);
      }

      const btnFin = h("button", { textContent: t.finalize });
      btnFin.onclick = settleCapture;
      panel.appendChild(btnFin);
    } else {
      const btnTxt = h("button", {
        className: "pri",
        textContent: `${t.dlTxt} (${available})`,
      });
      btnTxt.onclick = () =>
        downloadFile(formatTxt(), "yandex_tracks.txt", "text/plain;charset=utf-8");
      panel.appendChild(btnTxt);

      const btnCsv = h("button", { textContent: `${t.dlCsv} (${available})` });
      btnCsv.onclick = () =>
        downloadFile(formatCsv(), "yandex_tracks.csv", "text/csv;charset=utf-8");
      panel.appendChild(btnCsv);

      const btnJson = h("button", { textContent: `Download .json (${available})` });
      btnJson.onclick = () =>
        downloadFile(formatJson(), "yandex_tracks.json", "application/json;charset=utf-8");
      panel.appendChild(btnJson);
    }
  };

  // ====== Scroll listener (manual mode) ======
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  const onScroll = debounce(() => {
    if (!running) return;
    extractTracks();
    if (!autoScrolling) {
      renderPanel(statusStr(t.collecting));
    }
  }, CFG.debounceMs);

  // ====== Init ======
  injectStyles();
  readExpectedTotal();
  extractTracks();
  renderPanel();
  getScroller().addEventListener("scroll", onScroll, { passive: true });

  console.log("[YM Collector] Ready.",
    "Tracks in DOM:", tracks.size,
    "Expected total:", expectedTotal || "unknown",
    "Language:", LANG);
})();
