import { STATE } from "../state.js";
import { fetchJson, stripTrailingSlash } from "../utils.js";

function pickBestFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const prefer = ["4x.webp", "3x.webp", "2x.webp", "1x.webp", "4x", "3x", "2x", "1x"];
  for (const want of prefer) {
    const f = files.find(x => String(x?.name || "") === want);
    if (f) return f;
  }
  return files[0] || null;
}

function add7TVSetEmotes(setObj) {
  const emotes = Array.isArray(setObj?.emotes) ? setObj.emotes : [];
  for (const item of emotes) {
    const name = item?.name;
    const host = item?.data?.host;

    // ✅ 7TV uses host.url, NOT host.uri
    const hostUrl = host?.url;
    const files = host?.files;

    if (!name || !hostUrl || !Array.isArray(files) || files.length === 0) continue;

    const file = pickBestFile(files);
    if (!file?.name) continue;

    const url = `https:${hostUrl}/${file.name}`;

    STATE.emoteMap3P.set(name, { url, provider: "7tv" });
    STATE.emoteMap3P.set(String(name).toLowerCase(), { url, provider: "7tv" }); // optional
  }
}

export async function load7TV(cfg) {
  const p7 = cfg?.emotes?.providers?.["7tv"] || {};

  // ✅ correct default, even if cfg is missing/malformed
  const baseUrl = stripTrailingSlash(p7.baseUrl || "https://7tv.io/v3");

  // Global set (optional)
  try {
    const globalSet = await fetchJson(`${baseUrl}/emote-sets/global`, { cache: "no-store" });
    add7TVSetEmotes(globalSet);
  } catch (e) {
    console.warn("7TV global load failed:", e);
  }

  // Channel set (where widepeepoHappy would normally come from)
  if (STATE.channelId) {
    try {
      const user = await fetchJson(
        `${baseUrl}/users/twitch/${encodeURIComponent(STATE.channelId)}`,
        { cache: "no-store" }
      );
      if (user?.emote_set) add7TVSetEmotes(user.emote_set);
    } catch (e) {
      console.warn("7TV channel load failed:", e);
    }
  }
}
