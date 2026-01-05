import { STATE } from "../state.js";
import { fetchJson } from "../utils.js";

export async function loadBTTV(cfg) {
  const globalUrl = "https://api.betterttv.net/3/cached/emotes/global";
  const global = await fetchJson(globalUrl);

  for (const e of Array.isArray(global) ? global : []) {
    if (!e?.code || !e?.id) continue;
    STATE.emoteMap3P.set(e.code, { url: `https://cdn.betterttv.net/emote/${e.id}/1x`, provider: "bttv" });
  }

  if (STATE.channelId) {
    const chanUrl = `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(STATE.channelId)}`;
    const data = await fetchJson(chanUrl);

    const all = []
      .concat(Array.isArray(data?.channelEmotes) ? data.channelEmotes : [])
      .concat(Array.isArray(data?.sharedEmotes) ? data.sharedEmotes : []);

    for (const e of all) {
      if (!e?.code || !e?.id) continue;
      STATE.emoteMap3P.set(e.code, { url: `https://cdn.betterttv.net/emote/${e.id}/1x`, provider: "bttv" });
    }
  }
}
