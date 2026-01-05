import { STATE } from "../state.js";
import { fetchJson } from "../utils.js";

function add(code, url) {
  if (!code || !url) return;
  STATE.emoteMap3P.set(code, { url, provider: "bttv" });
  STATE.emoteMap3P.set(String(code).toLowerCase(), { url, provider: "bttv" }); // optional case-insensitive
}

function cdnUrl(id) {
  // 3x is a good default for readability
  return `https://cdn.betterttv.net/emote/${id}/3x`;
}

export async function loadBTTV(cfg) {
  const baseUrl =
    (cfg?.emotes?.providers?.bttv?.baseUrl) ||
    "https://api.betterttv.net/3";

  // 1) Global emotes
  try {
    const global = await fetchJson(`${baseUrl}/cached/emotes/global`, { cache: "no-store" });
    for (const e of (global || [])) {
      if (e?.code && e?.id) add(e.code, cdnUrl(e.id));
    }
  } catch (e) {
    console.warn("BTTV global load failed:", e);
  }

  // 2) Channel emotes (THIS is where widepeepoHappy often lives)
  // BTTV expects Twitch User ID
  if (!STATE.channelId) return;

  try {
    const user = await fetchJson(`${baseUrl}/cached/users/twitch/${encodeURIComponent(STATE.channelId)}`, { cache: "no-store" });

    // BTTV user payload: { channelEmotes: [], sharedEmotes: [] }
    const channelEmotes = Array.isArray(user?.channelEmotes) ? user.channelEmotes : [];
    const sharedEmotes = Array.isArray(user?.sharedEmotes) ? user.sharedEmotes : [];

    for (const e of [...channelEmotes, ...sharedEmotes]) {
      if (e?.code && e?.id) add(e.code, cdnUrl(e.id));
    }
  } catch (e) {
    console.warn("BTTV channel load failed:", e);
  }
}
