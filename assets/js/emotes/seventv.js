import { STATE } from "../state.js";
import { fetchJson, stripTrailingSlash } from "../utils.js";

export async function load7TV(cfg) {
  const baseUrl = cfg.emotes.providers["7tv"]?.baseUrl || "https://api.7tv.app/v3";

  const globalSet = await fetchJson(`${stripTrailingSlash(baseUrl)}/emote-sets/global`);
  add7TVSetEmotes(globalSet);

  if (STATE.channelId) {
    const user = await fetchJson(`${stripTrailingSlash(baseUrl)}/users/twitch/${encodeURIComponent(STATE.channelId)}`);
    if (user?.emote_set) add7TVSetEmotes(user.emote_set);
  }
}

function add7TVSetEmotes(setObj) {
  const emotes = Array.isArray(setObj?.emotes) ? setObj.emotes : [];
  for (const item of emotes) {
    const name = item?.name;
    const data = item?.data;
    const host = data?.host;
    if (!name || !host?.url || !Array.isArray(host.files)) continue;

    const file =
      host.files.find(f => String(f.name).startsWith("1x")) ||
      host.files.find(f => String(f.name).endsWith(".webp")) ||
      host.files[0];

    if (!file?.name) continue;

    const url = `https:${host.url}/${file.name}`;
    STATE.emoteMap3P.set(name, { url, provider: "7tv" });
  }
}
