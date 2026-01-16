import { STATE } from "../state.js";
import { fetchJson } from "../utils.js";

function add(code, url) {
  if (!code || !url) return;
  STATE.emoteMap3P.set(code, { url, provider: "bttv" });
  STATE.emoteMap3P.set(String(code).toLowerCase(), { url, provider: "bttv" });
}

function cdnUrl(id) {
  return `https://cdn.betterttv.net/emote/${id}/3x`;
}

// IMPORTANT: named export must be EXACTLY loadBTTV (index.js imports this name)
export async function loadBTTV(cfg) {
  const baseUrl = cfg?.emotes?.providers?.bttv?.baseUrl || "https://api.betterttv.net/3";

  // Global emotes
  const global = await fetchJson(`${baseUrl}/cached/emotes/global`, { cache: "no-store" }).catch(() => []);
  for (const e of (global || [])) {
    if (e?.code && e?.id) add(e.code, cdnUrl(e.id));
  }

  // Channel emotes
  if (!STATE.channelId) return;

  const user = await fetchJson(
    `${baseUrl}/cached/users/twitch/${encodeURIComponent(STATE.channelId)}`,
    { cache: "no-store" }
  ).catch(() => null);

  const channelEmotes = Array.isArray(user?.channelEmotes) ? user.channelEmotes : [];
  const sharedEmotes = Array.isArray(user?.sharedEmotes) ? user.sharedEmotes : [];

  for (const e of [...channelEmotes, ...sharedEmotes]) {
    if (e?.code && e?.id) add(e.code, cdnUrl(e.id));
  }
}
