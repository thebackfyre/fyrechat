import { STATE } from "./state.js";

export function initDebugDom() {
  STATE.$debug = document.getElementById("debug");
  if (STATE.$debug) STATE.$debug.style.display = "none";
}

export function updateDebugBanner(cfg, statusText) {
  if (!cfg.debug || !STATE.$debug) return;

  const mode = cfg.demo ? "DEMO" : "IRC";
  const badgesOn = !!cfg.badgeProxy;
  const emotesOn = !!cfg.emotes?.enabled;

  const badgeSets = (badgesOn && STATE.badgesReady) ? "on" : "off";
  const badgeErr = STATE.badgeErr ? ` | badgeErr=${STATE.badgeErr}` : "";
  const idErr = STATE.channelIdErr ? ` | idErr=${STATE.channelIdErr}` : "";

  const emoteCount = STATE.emoteMap3P ? STATE.emoteMap3P.size : 0;

  const providers = cfg.emotes?.providers || {};
  const providerFlags = [
    providers.bttv?.enabled ? "BTTV" : null,
    providers["7tv"]?.enabled ? "7TV" : null,
    providers.ffz?.enabled ? "FFZ" : null
  ].filter(Boolean).join(",");

  const s = cfg.style || {};
  const styleBits = [];
  if (s.badgeSize) styleBits.push(`badge=${s.badgeSize}`);
  if (s.emoteSize) styleBits.push(`emote=${s.emoteSize}`);
  if (s.textSize) styleBits.push(`text=${s.textSize}`);
  if (s.nameSize) styleBits.push(`name=${s.nameSize}`);

  const styleText = styleBits.length ? ` | style(${styleBits.join(",")})` : "";

  STATE.$debug.style.display = "block";
  STATE.$debug.textContent =
    `${mode} | ch=${cfg.channel} | max=${cfg.max} | ttl=${cfg.ttl}s | fade=${cfg.fade}s` +
    ` | badges=${badgesOn ? "on" : "off"} | emotes=${emotesOn ? "on" : "off"}` +
    ` | badgeSets=${badgeSets}, 3pEmotes=${emoteCount}` +
    (providerFlags ? ` [${providerFlags}]` : "") +
    styleText +
    (statusText ? ` | ${statusText}` : "") +
    badgeErr + idErr;
}
