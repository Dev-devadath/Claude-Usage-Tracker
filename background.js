const ALARM = "claude-usage-poll";
const POLL_MINUTES = 5;

async function getOrgId() {
  const { orgId } = await chrome.storage.local.get("orgId");
  return orgId ?? null;
}

async function fetchUsageFromBackground() {
  const orgId = await getOrgId();
  if (!orgId) return;

  try {
    const res = await fetch(
      `https://claude.ai/api/organizations/${orgId}/usage`,
      { credentials: "include" },
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        await chrome.storage.local.set({
          usageError: "session",
          lastUpdated: Date.now(),
        });
      }
      return;
    }

    const data = await res.json();
    await chrome.storage.local.set({
      usage: data,
      usageError: null,
      lastUpdated: Date.now(),
    });

    const pct = Math.max(
      data?.five_hour?.utilization ?? 0,
      data?.seven_day?.utilization ?? 0,
    );
    const text = pct >= 100 ? "!" : `${Math.round(pct)}%`;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({
      color: pct >= 90 ? "#c2410c" : pct >= 70 ? "#ea580c" : "#292524",
    });
  } catch {
    // network / extension context — ignore; content script may refresh on page
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: POLL_MINUTES });
  fetchUsageFromBackground();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: POLL_MINUTES });
  fetchUsageFromBackground();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) fetchUsageFromBackground();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ORG_READY" || msg?.type === "REFRESH_USAGE") {
    fetchUsageFromBackground().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
