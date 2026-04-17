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

  function buildShadowHTML() {
    return `
      <style>
        :host { all: initial; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
        * { box-sizing: border-box; }
        .panel {
          position: fixed;
          bottom: max(12px, env(safe-area-inset-bottom, 0px));
          left: 10px;
          right: auto;
          top: auto;
          z-index: 2147483646;
          min-width: 200px;
          /* Sits in the strip between Claude’s left sidebar and the chat column */
          max-width: min(280px, calc(100vw - 24px));
          background: ${theme.bg};
          border: 1px solid ${theme.border};
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(234, 88, 12, 0.12);
          color: ${theme.text};
          font-size: 12px;
          line-height: 1.35;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        @media (min-width: 768px) {
          .panel {
            left: 200px;
            max-width: min(280px, calc(100vw - 252px));
          }
        }
        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 10px;
          background: linear-gradient(180deg, ${theme.bgElevated} 0%, ${theme.bg} 100%);
          border-bottom: 1px solid ${theme.border};
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
          letter-spacing: 0.02em;
          font-size: 11px;
          text-transform: uppercase;
          color: ${theme.muted};
        }
        .brand svg { flex-shrink: 0; }
        .actions { display: flex; gap: 4px; }
        button.icon-btn {
          display: grid;
          place-items: center;
          width: 28px;
          height: 28px;
          padding: 0;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: ${theme.muted};
          cursor: pointer;
        }
        button.icon-btn:hover { color: ${theme.orange}; background: rgba(234, 88, 12, 0.12); }
        .body { padding: 10px 10px 12px; }
        .body.collapsed { display: none; }
        .row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
        }
        .row:last-child { margin-bottom: 0; }
        .label {
          width: 52px;
          flex-shrink: 0;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: ${theme.muted};
        }
        .bar-wrap { flex: 1; min-width: 0; }
        .bar-track {
          height: 6px;
          border-radius: 999px;
          background: ${theme.track};
          overflow: hidden;
        }
        .bar-fill {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #c2410c 0%, ${theme.orange} 55%, #fb923c 100%);
          box-shadow: 0 0 12px ${theme.orangeDim};
          transition: width 0.35s ease;
        }
        .pct {
          width: 36px;
          text-align: right;
          font-variant-numeric: tabular-nums;
          font-weight: 600;
          color: ${theme.text};
        }
        .meta {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid ${theme.border};
          font-size: 10px;
          color: ${theme.muted};
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .state-msg {
          padding: 12px 10px;
          text-align: center;
          color: ${theme.muted};
          font-size: 11px;
        }
        .state-msg strong { color: ${theme.orange}; font-weight: 600; }
        .mini {
          display: flex;
          gap: 6px;
          padding: 6px 8px;
          justify-content: flex-end;
        }
        .mini.hidden { display: none; }
        .orb {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 2px solid ${theme.border};
          display: grid;
          place-items: center;
          font-size: 10px;
          font-weight: 700;
          color: ${theme.text};
          background: ${theme.bgElevated};
        }
        .orb span { color: ${theme.orange}; }
      </style>
      <div class="panel" part="panel">
        <div class="head">
          <div class="brand" title="Claude usage (unofficial)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" stroke="${theme.orange}" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M12 22V12M12 12L4 7M12 12l8-5" stroke="${theme.muted}" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            Usage
          </div>
          <div class="actions">
            <button type="button" class="icon-btn" id="ct-refresh" title="Refresh" aria-label="Refresh">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 16h5v5"/>
              </svg>
            </button>
            <button type="button" class="icon-btn" id="ct-collapse" title="Minimize" aria-label="Minimize">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 14h16M4 10h16"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="body" id="ct-body">
          <div class="state-msg" id="ct-state">Loading…</div>
        </div>
        <div class="mini hidden" id="ct-mini" aria-hidden="true">
          <div class="orb" title="5h window"><span id="ct-m5">—</span></div>
          <div class="orb" title="7d window"><span id="ct-m7">—</span></div>
        </div>
      </div>
    `;
  }

  function renderUsage(shadow, usage, usageError) {
    const body = shadow.getElementById("ct-body");
    const m5 = shadow.getElementById("ct-m5");
    const m7 = shadow.getElementById("ct-m7");

    if (
      usageError === "session" ||
      usageError === "no_org" ||
      usageError === "fetch"
    ) {
      body.innerHTML = "";
      const div = el(`
        <div class="state-msg">
          ${usageError === "session" ? "<strong>Session expired.</strong> Refresh the page and sign in again." : ""}
          ${usageError === "no_org" ? "<strong>No org ID yet.</strong> Wait for Claude to finish loading, or refresh the page." : ""}
          ${usageError === "fetch" ? "<strong>Could not load usage.</strong> Check your connection." : ""}
        </div>
      `);
      body.appendChild(div);
      m5.textContent = "—";
      m7.textContent = "—";
      return;
    }

    if (!usage) {
      body.innerHTML = '<div class="state-msg" id="ct-state">Loading…</div>';
      return;
    }

    const h5 = usage.five_hour?.utilization ?? 0;
    const h7 = usage.seven_day?.utilization ?? 0;
    const r5 = usage.five_hour?.resets_at;
    const r7 = usage.seven_day?.resets_at;

    body.innerHTML = "";
    body.appendChild(
      el(`
        <div>
          <div class="row">
            <div class="label">5h</div>
            <div class="bar-wrap">
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, h5)}%"></div></div>
            </div>
            <div class="pct">${Math.round(h5)}%</div>
          </div>
          <div class="row">
            <div class="label">7d</div>
            <div class="bar-wrap">
              <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, h7)}%"></div></div>
            </div>
            <div class="pct">${Math.round(h7)}%</div>
          </div>
          <div class="meta">
            <span class="pill" title="5h window reset">5h reset · ${formatCountdown(r5)}</span>
            <span class="pill" title="Weekly reset">7d reset · ${formatCountdown(r7)}</span>
          </div>
        </div>
      `),
    );

    m5.textContent = `${Math.round(h5)}%`;
    m7.textContent = `${Math.round(h7)}%`;
  }

  function mount() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-claude-tracker", "");
    const shadow = host.attachShadow({ mode: "open" });
    appendHtmlToShadow(shadow, buildShadowHTML());
    document.documentElement.appendChild(host);

    const body = shadow.getElementById("ct-body");
    const mini = shadow.getElementById("ct-mini");
    let collapsed = false;

    shadow.getElementById("ct-collapse").addEventListener("click", () => {
      collapsed = !collapsed;
      body.classList.toggle("collapsed", collapsed);
      mini.classList.toggle("hidden", !collapsed);
      mini.setAttribute("aria-hidden", collapsed ? "false" : "true");
      const btn = shadow.getElementById("ct-collapse");
      btn.innerHTML = collapsed
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 5v14l11-7-11-7z"/></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h16M4 10h16"/></svg>`;
      btn.title = collapsed ? "Expand" : "Minimize";
      btn.setAttribute("aria-label", collapsed ? "Expand" : "Minimize");
    });

    shadow.getElementById("ct-refresh").addEventListener("click", () => {
      fetchUsagePage().then(() => paintFromStorage());
    });

    async function paintFromStorage() {
      const { usage, usageError, lastUpdated } = await stGet([
        "usage",
        "usageError",
        "lastUpdated",
      ]);
      renderUsage(shadow, usage, usageError);
      shadow.getElementById("ct-updated")?.remove();
      if (usage && !usageError && lastUpdated) {
        const agoSec = Math.round((Date.now() - lastUpdated) / 1000);
        const agoLabel =
          agoSec < 60
            ? `${agoSec}s`
            : agoSec < 3600
              ? `${Math.floor(agoSec / 60)}m`
              : `${Math.floor(agoSec / 3600)}h`;
        const sub = el(
          `<div id="ct-updated" style="margin-top:6px;font-size:9px;color:${theme.muted};text-align:right">Updated ${agoLabel} ago</div>`,
        );
        body.appendChild(sub);
      }
    }

    const unsubStorage = subscribeStorage((changes, area) => {
      if (area !== "local") return;
      if (changes.usage || changes.usageError || changes.lastUpdated) {
        paintFromStorage();
      }
    });

    const updatedTicker = setInterval(() => {
      stGet(["usage", "usageError", "lastUpdated"]).then(
        ({ usage, usageError, lastUpdated }) => {
          if (!usage || usageError || !lastUpdated) return;
          const elUp = shadow.getElementById("ct-updated");
          if (!elUp) return;
          const agoSec = Math.round((Date.now() - lastUpdated) / 1000);
          const agoLabel =
            agoSec < 60
              ? `${agoSec}s`
              : agoSec < 3600
                ? `${Math.floor(agoSec / 60)}m`
                : `${Math.floor(agoSec / 3600)}h`;
          elUp.textContent = `Updated ${agoLabel} ago`;
        },
      );
    }, 15000);

    const countdown = setInterval(() => {
      stGet("usage").then(({ usage: u }) => {
        if (!u || collapsed) return;
        const meta = shadow.querySelector(".meta");
        if (!meta) return;
        const r5 = u.five_hour?.resets_at;
        const r7 = u.seven_day?.resets_at;
        const pills = meta.querySelectorAll(".pill");
        if (pills[0])
          pills[0].textContent = `5h reset · ${formatCountdown(r5)}`;
        if (pills[1])
          pills[1].textContent = `7d reset · ${formatCountdown(r7)}`;
      });
    }, 1000);

    window.addEventListener("beforeunload", () => {
      clearInterval(updatedTicker);
      clearInterval(countdown);
      clearNoOrgTimer();
      clearLocationPoll();
      unsubStorage();
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
