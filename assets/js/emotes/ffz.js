import { STATE } from "../state.js";
import { fetchJson } from "../utils.js";

export async function loadFFZ(cfg) {
  // Global FFZ
  const global = await fetchJson("https://api.frankerfacez.com/v1/set/global");
  ingestFFZSet(global?.sets);

  // Channel FFZ (requires twitch channel id)
  if (STATE.channelId) {
    const chan = await fetchJson(`https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(STATE.channelId)}`);
    ingestFFZSet(chan?.sets);
  }
}

function ingestFFZSet(setsObj) {
  if (!setsObj || typeof setsObj !== "object") return;

  for (const set of Object.values(setsObj)) {
    const emotes = Array.isArray(set?.emoticons) ? set.emoticons : [];
    for (const e of emotes) {
      const name = e?.name;
      const urls = e?.urls;
      if (!name || !urls) continue;

      const url = urls["1"] || urls["2"] || urls["4"];
      if (!url) continue;

      const finalUrl = String(url).startsWith("//") ? `https:${url}` : url;
      STATE.emoteMap3P.set(name, { url: finalUrl, provider: "ffz" });
    }
  }
}
