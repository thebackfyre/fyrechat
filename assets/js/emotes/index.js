import { STATE } from "../state.js";
import { loadBTTV } from "./bttv.js";
import { load7TV } from "./seventv.js";
import { loadFFZ } from "./ffz.js";

function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "yes";
}

function emotesEnabled(cfg) {
  const v = cfg?.emotes;
  if (truthy(v)) return true;                 // cfg.emotes = true / "1"
  if (v && typeof v === "object") return truthy(v.enabled);
  return false;
}

function providerEnabled(cfg, key) {
  // Prefer nested config: cfg.emotes.providers[key].enabled
  const nested = cfg?.emotes?.providers?.[key]?.enabled;
  if (nested !== undefined) return truthy(nested);

  // Accept common flat flags:
  // bttv=1 -> cfg.bttv
  // ffz=1  -> cfg.ffz
  // 7tv=1  -> cfg["7tv"] or cfg.seventv or cfg.stv
  if (key === "bttv") return truthy(cfg?.bttv);
  if (key === "ffz") return truthy(cfg?.ffz);

  if (key === "7tv") {
    return truthy(cfg?.["7tv"]) || truthy(cfg?.seventv) || truthy(cfg?.stv) || truthy(cfg?.tv7);
  }

  return false;
}

export async function loadThirdPartyEmotes(cfg) {
  STATE.emoteErr = "";
  STATE.emotesReady = false;
  STATE.emoteMap3P = new Map();

  if (!emotesEnabled(cfg)) return;

  const tasks = [];

  if (providerEnabled(cfg, "bttv")) {
    tasks.push(loadBTTV(cfg).catch((e) => console.warn("BTTV load failed:", e)));
  }
  if (providerEnabled(cfg, "7tv")) {
    tasks.push(load7TV(cfg).catch((e) => console.warn("7TV load failed:", e)));
  }
  if (providerEnabled(cfg, "ffz")) {
    tasks.push(loadFFZ(cfg).catch((e) => console.warn("FFZ load failed:", e)));
  }

  await Promise.all(tasks);
  STATE.emotesReady = true;
}
