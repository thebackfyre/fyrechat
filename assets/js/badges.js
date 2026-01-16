import { STATE } from "./state.js";
import { fetchJson } from "./utils.js";

export async function loadBadges(cfg) {
  STATE.badgesReady = false;
  STATE.badgeErr = "";
  STATE.badgeMapGlobal = new Map();
  STATE.badgeMapChannel = new Map();

  if (!cfg.badgeProxy) return;

  try {
    const global = await fetchJson(`${cfg.badgeProxy}/badges/global`, { cache: "no-store" });
    ingestBadgePayload(global, STATE.badgeMapGlobal);
  } catch (e) {
    STATE.badgeErr = "global fetch failed";
    console.warn("Global badges failed:", e);
  }

  if (STATE.channelId) {
    try {
      const chan = await fetchJson(`${cfg.badgeProxy}/badges/channels/${encodeURIComponent(STATE.channelId)}`, { cache: "no-store" });
      ingestBadgePayload(chan, STATE.badgeMapChannel);
    } catch (e) {
      STATE.badgeErr = STATE.badgeErr || "channel fetch failed";
      console.warn("Channel badges failed:", e);
    }
  }

  STATE.badgesReady = STATE.badgeMapGlobal.size > 0;
}

function ingestBadgePayload(payload, mapOut) {
  // Supports either:
  //  - Twitch original: { badge_sets: {...} }
  //  - Your worker wrapper: { data: [ {set_id, versions:[...]} ] }
  if (!payload) return;

  // Worker wrapper
  if (Array.isArray(payload.data)) {
    for (const set of payload.data) {
      const setId = set?.set_id;
      const versions = Array.isArray(set?.versions) ? set.versions : [];
      if (!setId || !versions.length) continue;

      const verMap = new Map();
      for (const v of versions) {
        if (!v?.id) continue;
        verMap.set(String(v.id), v.image_url_1x || v.image_url_2x || v.image_url_4x);
      }
      mapOut.set(setId, verMap);
    }
    return;
  }

  // Twitch original
  if (payload.badge_sets && typeof payload.badge_sets === "object") {
    for (const [setId, setObj] of Object.entries(payload.badge_sets)) {
      const versions = setObj?.versions || {};
      const verMap = new Map();
      for (const [ver, vobj] of Object.entries(versions)) {
        const url = vobj?.image_url_1x || vobj?.image_url_2x || vobj?.image_url_4x;
        if (url) verMap.set(String(ver), url);
      }
      if (verMap.size) mapOut.set(setId, verMap);
    }
  }
}
