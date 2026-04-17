(() => {
  const HOST_ID = "claude-tracker-usage-host";

  /** Some environments omit `chrome.storage` on content scripts; proxy via background. */
  const canStorage = (() => {
    try {
      const s = globalThis.chrome?.storage?.local;
      return !!(
        s &&
        typeof s.get === "function" &&
        typeof s.set === "function"
      );
    } catch (_) {
      return false;
    }
  })();

  async function stGet(keys) {
    if (canStorage) return globalThis.chrome.storage.local.get(keys);
    const r = await globalThis.chrome.runtime.sendMessage({
      type: "STORAGE_GET",
      keys,
    });
    return r ?? {};
  }

  async function stSet(data) {
    if (canStorage) return globalThis.chrome.storage.local.set(data);
    await globalThis.chrome.runtime.sendMessage({
      type: "STORAGE_SET",
      data,
    });
  }

  function subscribeStorage(handler) {
    if (canStorage) {
      const fn = (changes, area) => {
        if (area === "local") handler(changes, area);
      };
      globalThis.chrome.storage.onChanged.addListener(fn);
      return () => globalThis.chrome.storage.onChanged.removeListener(fn);
    }
    const fn = (msg) => {
      if (msg?.type === "STORAGE_CHANGED") handler(msg.changes, msg.area);
    };
    globalThis.chrome.runtime.onMessage.addListener(fn);
    return () => globalThis.chrome.runtime.onMessage.removeListener(fn);
  }

  const theme = {
    bg: "#141413",
    bgElevated: "#1c1c1a",
    border: "rgba(255, 255, 255, 0.08)",
    text: "#fafaf9",
    muted: "#a8a29e",
    orange: "#ea580c",
    orangeDim: "rgba(234, 88, 12, 0.35)",
    track: "rgba(255, 255, 255, 0.08)",
  };

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  /** Appends every root node from the string (style + panel), not only the first. */
  function appendHtmlToShadow(shadow, html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    shadow.appendChild(t.content);
  }

  function formatCountdown(iso) {
    if (!iso) return "—";
    const end = new Date(iso).getTime();
    const now = Date.now();
    let s = Math.max(0, Math.floor((end - now) / 1000));
    const d = Math.floor(s / 86400);
    s %= 86400;
    const h = Math.floor(s / 3600);
    s %= 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** Matches claude.ai requests like /api/organizations/<uuid>/mcp/v2/bootstrap */
  const ORG_IN_URL =
    /\/api\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|\?|#|$)/i;

  function extractOrgIdFromUrl(url) {
    const m = String(url).match(ORG_IN_URL);
    return m ? m[1].toLowerCase() : null;
  }

  let noOrgTimerId = null;
  let locationPollId = null;
  let perfObserver = null;
  let orgDiscoveryStarted = false;

  function clearNoOrgTimer() {
    if (noOrgTimerId != null) {
      clearTimeout(noOrgTimerId);
      noOrgTimerId = null;
    }
  }

  function clearLocationPoll() {
    if (locationPollId != null) {
      clearInterval(locationPollId);
      locationPollId = null;
    }
  }

  function scanBufferedResourceEntries() {
    try {
      for (const e of performance.getEntriesByType("resource")) {
        if (e.name) probeUrlForOrg(e.name);
      }
    } catch (_) {
      /* older browsers */
    }
  }

  function probeUrlForOrg(url) {
    const id = extractOrgIdFromUrl(url);
    if (id) void persistOrgId(id);
  }

  async function persistOrgId(id) {
    if (!id) return;
    const { orgId: prev, usage } = await stGet(["orgId", "usage"]);
    await stSet({ orgId: id });
    clearNoOrgTimer();
    clearLocationPoll();

    const orgChanged = prev !== id;
    if (orgChanged) {
      chrome.runtime.sendMessage({ type: "ORG_READY" }).catch(() => {});
    }
    if (orgChanged || !usage) {
      await fetchUsagePage();
    }
  }

  function observeResourceUrls() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name) probeUrlForOrg(entry.name);
        }
      });
      perfObserver.observe({ type: "resource", buffered: true });
    } catch (_) {
      try {
        perfObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name) probeUrlForOrg(entry.name);
          }
        });
        perfObserver.observe({ entryTypes: ["resource"] });
      } catch (_) {
        /* ignore */
      }
    }
  }

  function scheduleNoOrgFallback() {
    clearNoOrgTimer();
    noOrgTimerId = setTimeout(async () => {
      noOrgTimerId = null;
      const { orgId } = await stGet("orgId");
      if (!orgId) {
        await stSet({
          usageError: "no_org",
          lastUpdated: Date.now(),
        });
      }
    }, 25000);
  }

  function startOrgDiscovery() {
    if (orgDiscoveryStarted) return;
    orgDiscoveryStarted = true;

    probeUrlForOrg(window.location.href);
    scanBufferedResourceEntries();
    observeResourceUrls();
    scheduleNoOrgFallback();

    window.addEventListener("popstate", () => {
      probeUrlForOrg(window.location.href);
    });

    try {
      const nav = window.navigation;
      if (nav && typeof nav.addEventListener === "function") {
        nav.addEventListener("navigate", () => {
          queueMicrotask(() => probeUrlForOrg(window.location.href));
        });
      }
    } catch (_) {
      /* Navigation API optional */
    }

    let ticks = 0;
    locationPollId = setInterval(() => {
      probeUrlForOrg(window.location.href);
      ticks += 1;
      if (ticks >= 45) clearLocationPoll();
    }, 2000);
  }

  async function fetchUsagePage() {
    const { orgId } = await stGet("orgId");
    if (!orgId) return;

    const res = await fetch(`/api/organizations/${orgId}/usage`, {
      credentials: "include",
    });
    if (!res.ok) {
      await stSet({
        usageError:
          res.status === 401 || res.status === 403 ? "session" : "fetch",
        lastUpdated: Date.now(),
      });
      return;
    }

    const data = await res.json();
    await stSet({
      usage: data,
      usageError: null,
      lastUpdated: Date.now(),
    });
    chrome.runtime.sendMessage({ type: "REFRESH_USAGE" }).catch(() => {});
  }

  function normalizeRect(r) {
    const left = r.left;
    const top = r.top;
    const width = r.width;
    const height = r.height;
    return {
      left,
      top,
      width,
      height,
      right: r.right ?? left + width,
      bottom: r.bottom ?? top + height,
    };
  }

  /** Inner rounded chat surface (Tailwind `!box-content`); falls back to container. */
  function getChatBoxElement() {
    const wrap = document.querySelector("[data-chat-input-container]");
    if (wrap) {
      const box = wrap.querySelector('[class*="box-content"]');
      if (box) return box;
    }
    return (
      document.querySelector(
        "[data-chat-input-container] [class*='rounded-']",
      ) || wrap
    );
  }

  let chatInputResizeObs = null;
  let chatInputObservedEl = null;

  function buildShadowHTML() {
    return `
      <style>
        :host { all: initial; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
        * { box-sizing: border-box; }
        .ct-surface {
          position: fixed;
          z-index: 2147483646;
          pointer-events: none;
        }
        .ct-surface.ct-zone {
          pointer-events: auto;
        }
        .ct-liquid {
          pointer-events: auto;
          background: rgba(255, 255, 255, 0.06);
          backdrop-filter: blur(20px) saturate(160%);
          -webkit-backdrop-filter: blur(20px) saturate(160%);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 999px;
          box-shadow:
            0 4px 24px rgba(0, 0, 0, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }
        .ct-liquid--dark {
          background: rgba(15, 15, 14, 0.35);
          border-color: rgba(255, 255, 255, 0.1);
        }
        .ct-row {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          min-height: 26px;
          width: 100%;
        }
        .ct-lab {
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: rgba(255, 255, 255, 0.55);
          flex-shrink: 0;
        }
        .bar-h-wrap { flex: 1; min-width: 28px; }
        .bar-h-wrap--7d { max-width: 68px; flex: 0 1 auto; }
        .bar-track-h {
          height: 4px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
        }
        .bar-fill-h {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #c2410c 0%, ${theme.orange} 55%, #fb923c 100%);
          box-shadow: 0 0 8px ${theme.orangeDim};
          transition: width 0.35s ease;
        }
        .bar-fill--7d {
          background: linear-gradient(90deg, #9a3412 0%, ${theme.orange} 50%, #fdba74 100%);
        }
        .pct-h {
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          font-size: 10px;
          color: rgba(255, 255, 255, 0.95);
          min-width: 28px;
          text-align: right;
          flex-shrink: 0;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
        }
        .ct-refresh-btn {
          width: 22px;
          height: 22px;
          padding: 0;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(20px) saturate(160%);
          -webkit-backdrop-filter: blur(20px) saturate(160%);
          color: rgba(255, 255, 255, 0.75);
          display: grid;
          place-items: center;
          pointer-events: auto;
          cursor: pointer;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
          flex-shrink: 0;
        }
        .ct-refresh-btn:hover {
          color: ${theme.orange};
          border-color: rgba(234, 88, 12, 0.35);
          background: rgba(234, 88, 12, 0.12);
        }
        .ct-reset-pill {
          font-size: 9px;
          line-height: 1.35;
          color: rgba(255, 255, 255, 0.92);
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
          padding: 5px 10px;
          max-width: 38%;
          word-break: break-word;
        }
        .ct-reset-pill--r {
          text-align: right;
          margin-left: auto;
        }
        .ct-status-badge {
          width: 42px;
          height: 42px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          font-size: 10px;
          font-weight: 800;
          color: rgba(255, 255, 255, 0.96);
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
          box-shadow:
            0 6px 18px rgba(0, 0, 0, 0.16),
            inset 0 1px 0 rgba(255, 255, 255, 0.12),
            inset 0 0 0 1px rgba(234, 88, 12, 0.18);
        }
        .state-msg {
          padding: 10px 14px;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.88);
          text-align: center;
          max-width: min(320px, 90vw);
          border-radius: 14px;
          background: rgba(15, 15, 14, 0.45);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .state-msg strong { color: ${theme.orange}; font-weight: 600; }
      </style>
      <div class="ct-root" id="ct-root">
        <div class="ct-surface ct-zone" id="ct-chip-5h">
          <div class="ct-liquid ct-liquid--dark ct-row">
            <span class="ct-lab">5H</span>
            <div class="bar-h-wrap">
              <div class="bar-track-h"><div class="bar-fill-h" id="ct-fill5h" style="width:0%"></div></div>
            </div>
            <span class="pct-h" id="ct-pct5h">—</span>
          </div>
        </div>
        <button type="button" class="ct-surface ct-zone ct-refresh-btn" id="ct-refresh" title="Refresh usage" aria-label="Refresh usage">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 16h5v5"/>
          </svg>
        </button>
        <div class="ct-surface ct-zone" id="ct-chip-7d">
          <div class="ct-liquid ct-liquid--dark ct-row">
            <span class="ct-lab">7D</span>
            <div class="bar-h-wrap bar-h-wrap--7d">
              <div class="bar-track-h"><div class="bar-fill-h bar-fill--7d" id="ct-fill7d" style="width:0%"></div></div>
            </div>
            <span class="pct-h" id="ct-pct7d">—</span>
            <button type="button" class="ct-refresh-btn" id="ct-refresh" title="Refresh usage" aria-label="Refresh usage">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 16h5v5"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="ct-surface ct-zone" id="ct-chip-reset5">
          <div class="ct-liquid ct-liquid--dark ct-reset-pill" id="ct-reset5">5h reset · —</div>
        </div>
        <div class="ct-surface ct-zone" id="ct-chip-reset7">
          <div class="ct-liquid ct-liquid--dark ct-reset-pill ct-reset-pill--r" id="ct-reset7">7d reset · —</div>
        </div>
        <div class="ct-surface ct-zone" id="ct-status-compact">
          <div class="ct-liquid ct-liquid--dark ct-status-badge" id="ct-status5h">—</div>
        </div>
        <div class="ct-surface" id="ct-error" style="display:none">
          <div class="state-msg" id="ct-error-msg"></div>
        </div>
      </div>
    `;
  }

  const ZONE_IDS = [
    "ct-chip-5h",
    "ct-chip-7d",
    "ct-chip-reset5",
    "ct-chip-reset7",
    "ct-status-compact",
  ];

  function isLikelyVisible(el) {
    if (!el || !el.isConnected) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  }

  /** True if two axis-aligned rects intersect (using left/top/right/bottom). */
  function rectsIntersect(a, b) {
    return !(
      a.right < b.left ||
      a.left > b.right ||
      a.bottom < b.top ||
      a.top > b.bottom
    );
  }

  /**
   * Panels beside or stacked around the composer often do not share pixels with
   * the chat box rect; inflate the composer rect so adjacent / stacked UI still triggers compact.
   */
  function inflatedChatRect(rect, padPx) {
    return {
      left: rect.left - padPx,
      top: rect.top - padPx,
      right: rect.right + padPx,
      bottom: rect.bottom + padPx,
    };
  }

  function hasCrowdingPanel(rect) {
    const pad = 72;
    const zone = inflatedChatRect(rect, pad);

    const probes = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      /* Artifacts / stacked canvas (Claude mobile + overlays) */
      '[class*="max-md:z-header"]',
      '[class*="max-md:absolute"][class*="inset-x-0"]',
      '[class*="max-md:top-0"][class*="inset-x-0"]',
      '[aria-label*="artifact" i]',
      '[aria-label*="canvas" i]',
      '[aria-label*="sidebar" i]',
      '[class*="artifact"]',
      '[class*="sidebar"]',
      '[class*="drawer"]',
      '[data-testid*="artifact"]',
      '[data-testid*="canvas"]',
    ];

    for (const sel of probes) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of nodes) {
        if (!isLikelyVisible(el)) continue;
        if (el.closest(`#${HOST_ID}`)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 72 || r.height < 36) continue;
        const b = {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
        };
        if (rectsIntersect(zone, b)) return true;
      }
    }
    return false;
  }

  function shouldCompactLayout(rect) {
    const leftGutter = rect.left;
    const rightGutter = window.innerWidth - rect.right;
    return (
      rect.width < 620 ||
      window.innerWidth < 1180 ||
      leftGutter < 40 ||
      rightGutter < 40 ||
      hasCrowdingPanel(rect)
    );
  }

  function layoutChatZones(shadow) {
    const chip5 = shadow.getElementById("ct-chip-5h");
    const chip7 = shadow.getElementById("ct-chip-7d");
    const cr5 = shadow.getElementById("ct-chip-reset5");
    const cr7 = shadow.getElementById("ct-chip-reset7");
    const compact = shadow.getElementById("ct-status-compact");
    const errEl = shadow.getElementById("ct-error");
    if (!chip5 || !chip7 || !cr5 || !cr7 || !compact) return;

    const el = getChatBoxElement();

    if (el && el !== chatInputObservedEl) {
      try {
        chatInputResizeObs?.disconnect();
        chatInputObservedEl = el;
        chatInputResizeObs = new ResizeObserver(() => {
          requestAnimationFrame(() => layoutChatZones(shadow));
        });
        chatInputResizeObs.observe(el);
      } catch (_) {
        /* ignore */
      }
    }

    const hideAll = () => {
      for (const id of ZONE_IDS) {
        const n = shadow.getElementById(id);
        if (n) n.style.display = "none";
      }
    };

    if (!el || !el.isConnected) {
      hideAll();
      return;
    }

    const rect = normalizeRect(el.getBoundingClientRect());
    if (rect.width < 64) {
      hideAll();
      return;
    }

    const compactMode = shouldCompactLayout(rect);
    if (errEl && errEl.style.display !== "none") {
      hideAll();
      errEl.style.left = `${rect.left + rect.width / 2}px`;
      errEl.style.top = `${rect.top + rect.height / 2}px`;
      errEl.style.transform = "translate(-50%, -50%)";
      errEl.style.zIndex = "2147483647";
      return;
    }

    if (compactMode) {
      chip5.style.display = "none";
      chip7.style.display = "none";
      cr5.style.display = "none";
      cr7.style.display = "none";
      compact.style.display = "";
    } else {
      chip5.style.display = "";
      chip7.style.display = "";
      cr5.style.display = "";
      cr7.style.display = "";
      compact.style.display = "none";
    }

    const chipH = 28;
    const gapMid = 5;
    const edgeGap = 4;
    /** Reset row sits above the chat box */
    const resetRowH = 30;
    const resetY = rect.top - resetRowH - edgeGap;
    /** Progress chips sit below the chat box */
    const barsY = rect.bottom + edgeGap;

    let w5 = Math.min(210, Math.max(120, rect.width * 0.44));
    let w7 = Math.min(118, Math.max(88, rect.width * 0.28));
    /* Refresh sits inside the 7D chip — only gap between 5H and 7D columns */
    const need = w5 + gapMid + w7;
    if (need > rect.width && rect.width > 0) {
      const s = (rect.width / need) * 0.98;
      w5 = Math.max(96, w5 * s);
      w7 = Math.max(72, w7 * s);
    }

    chip5.style.left = `${rect.left}px`;
    chip5.style.top = `${barsY}px`;
    chip5.style.width = `${w5}px`;

    chip7.style.left = `${rect.right - w7}px`;
    chip7.style.top = `${barsY}px`;
    chip7.style.width = `${w7}px`;

    const g = 5;
    const col = Math.max(120, (rect.width - g) / 2);
    cr5.style.left = `${rect.left}px`;
    cr5.style.top = `${resetY}px`;
    cr5.style.width = `${col}px`;

    cr7.style.left = `${rect.right - col}px`;
    cr7.style.top = `${resetY}px`;
    cr7.style.width = `${col}px`;

    compact.style.left = `${rect.right - 42}px`;
    compact.style.top = `${rect.bottom + edgeGap}px`;
    compact.style.width = "42px";
    compact.style.height = "42px";

    if (errEl) {
      errEl.style.left = `${rect.left + rect.width / 2}px`;
      errEl.style.top = `${rect.top + rect.height / 2}px`;
      errEl.style.transform = "translate(-50%, -50%)";
      errEl.style.zIndex = "2147483647";
    }
  }

  function renderUsage(shadow, usage, usageError) {
    const errWrap = shadow.getElementById("ct-error");
    const errMsg = shadow.getElementById("ct-error-msg");
    const fill5 = shadow.getElementById("ct-fill5h");
    const fill7 = shadow.getElementById("ct-fill7d");
    const pct5 = shadow.getElementById("ct-pct5h");
    const pct7 = shadow.getElementById("ct-pct7d");
    const reset5 = shadow.getElementById("ct-reset5");
    const reset7 = shadow.getElementById("ct-reset7");
    const status5 = shadow.getElementById("ct-status5h");

    const showZones = (on) => {
      for (const id of ZONE_IDS) {
        const z = shadow.getElementById(id);
        if (z) z.style.display = on ? "" : "none";
      }
    };

    if (
      usageError === "session" ||
      usageError === "no_org" ||
      usageError === "fetch"
    ) {
      showZones(false);
      if (errWrap && errMsg) {
        errWrap.style.display = "";
        errMsg.innerHTML =
          usageError === "session"
            ? "<strong>Session expired.</strong> Refresh the page and sign in again."
            : usageError === "no_org"
              ? "<strong>No org ID yet.</strong> Wait for Claude to finish loading, or refresh."
              : "<strong>Could not load usage.</strong> Check your connection.";
      }
      if (fill5) fill5.style.width = "0%";
      if (fill7) fill7.style.width = "0%";
      if (pct5) pct5.textContent = "—";
      if (pct7) pct7.textContent = "—";
      if (status5) status5.textContent = "—";
      return;
    }

    if (errWrap) errWrap.style.display = "none";
    showZones(true);

    if (!usage) {
      if (fill5) fill5.style.width = "0%";
      if (fill7) fill7.style.width = "0%";
      if (pct5) pct5.textContent = "…";
      if (pct7) pct7.textContent = "…";
      if (reset5) reset5.textContent = "5h reset · …";
      if (reset7) reset7.textContent = "7d reset · …";
      if (status5) status5.textContent = "…";
      return;
    }

    const h5 = usage.five_hour?.utilization ?? 0;
    const h7 = usage.seven_day?.utilization ?? 0;
    const r5 = usage.five_hour?.resets_at;
    const r7 = usage.seven_day?.resets_at;

    if (fill5) fill5.style.width = `${Math.min(100, h5)}%`;
    if (fill7) fill7.style.width = `${Math.min(100, h7)}%`;
    if (pct5) pct5.textContent = `${Math.round(h5)}%`;
    if (pct7) pct7.textContent = `${Math.round(h7)}%`;
    if (reset5) reset5.textContent = `5h reset · ${formatCountdown(r5)}`;
    if (reset7) reset7.textContent = `7d reset · ${formatCountdown(r7)}`;
    if (status5) status5.textContent = `${Math.round(h5)}%`;
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-claude-tracker", "");
    const shadow = host.attachShadow({ mode: "open" });
    appendHtmlToShadow(shadow, buildShadowHTML());
    document.documentElement.appendChild(host);

    const scheduleLayout = () => {
      requestAnimationFrame(() => layoutChatZones(shadow));
    };

    shadow.getElementById("ct-refresh")?.addEventListener("click", () => {
      fetchUsagePage().then(() => paintFromStorage());
    });

    async function paintFromStorage() {
      const { usage, usageError } = await stGet(["usage", "usageError"]);
      renderUsage(shadow, usage, usageError);
      scheduleLayout();
    }

    const unsubStorage = subscribeStorage((changes, area) => {
      if (area !== "local") return;
      if (changes.usage || changes.usageError) {
        paintFromStorage();
      }
    });

    const countdown = setInterval(() => {
      stGet("usage").then(({ usage: u }) => {
        if (!u) return;
        const r5 = u.five_hour?.resets_at;
        const r7 = u.seven_day?.resets_at;
        const rs5 = shadow.getElementById("ct-reset5");
        const rs7 = shadow.getElementById("ct-reset7");
        if (rs5) rs5.textContent = `5h reset · ${formatCountdown(r5)}`;
        if (rs7) rs7.textContent = `7d reset · ${formatCountdown(r7)}`;
      });
    }, 1000);

    let resizeObs = null;
    try {
      resizeObs = new ResizeObserver(scheduleLayout);
      resizeObs.observe(document.documentElement);
      if (document.body) resizeObs.observe(document.body);
    } catch (_) {
      /* ignore */
    }

    window.addEventListener("resize", scheduleLayout, { passive: true });
    window.addEventListener("scroll", scheduleLayout, {
      passive: true,
      capture: true,
    });

    let domMoTimer = null;
    let domObserver = null;
    try {
      domObserver = new MutationObserver(() => {
        clearTimeout(domMoTimer);
        domMoTimer = setTimeout(scheduleLayout, 60);
      });
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      });
    } catch (_) {
      /* ignore */
    }

    window.addEventListener("beforeunload", () => {
      clearInterval(countdown);
      clearNoOrgTimer();
      clearLocationPoll();
      clearTimeout(domMoTimer);
      unsubStorage();
      try {
        domObserver?.disconnect();
      } catch (_) {
        /* ignore */
      }
      try {
        resizeObs?.disconnect();
      } catch (_) {
        /* ignore */
      }
      try {
        chatInputResizeObs?.disconnect();
        chatInputResizeObs = null;
        chatInputObservedEl = null;
      } catch (_) {
        /* ignore */
      }
      try {
        perfObserver?.disconnect();
      } catch (_) {
        /* ignore */
      }
    });

    fetchUsagePage().then(() => paintFromStorage());
    paintFromStorage();
  }

  function boot() {
    mount();
    startOrgDiscovery();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
