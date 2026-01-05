import { STATE } from "../state.js";
import { loadBTTV } from "./bttv.js";
import { load7TV } from "./seventv.js";
import { loadFFZ } from "./ffz.js";

export async function loadThirdPartyEmotes(cfg) {
  STATE.emoteErr = "";
  STATE.emotesReady = false;
  STATE.emoteMap3P = new Map();

  if (!cfg.emotes?.enabled) return;

  const providers = cfg.emotes.providers || {};
  const tasks = [];

  if (providers.bttv?.enabled) tasks.push(loadBTTV(cfg).catch(e => console.warn("BTTV load failed:", e)));
  if (providers["7tv"]?.enabled) tasks.push(load7TV(cfg).catch(e => console.warn("7TV load failed:", e)));
  if (providers.ffz?.enabled) tasks.push(loadFFZ(cfg).catch(e => console.warn("FFZ load failed:", e)));

  await Promise.all(tasks);
  STATE.emotesReady = true;
}
