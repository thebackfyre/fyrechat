import { STATE } from "./state.js";
import { buildMessageHtmlParts, addMessage } from "./render.js";
import { updateDebugBanner } from "./debug.js";

export function connectIrc(cfg) {
  const chan = cfg.channel;
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

  ws.addEventListener("open", () => {
    updateDebugBanner(cfg, `Connected ✅ as ${anonNick}`);
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("PASS SCHMOOPIIE");
    ws.send("NICK " + anonNick);
    ws.send("JOIN #" + chan);
  });

  ws.addEventListener("message", (ev) => {
    const data = String(ev.data || "");
    if (data.startsWith("PING")) {
      ws.send("PONG :tmi.twitch.tv");
      return;
    }

    const lines = data.split("\r\n").filter(Boolean);
    for (const line of lines) {
      if (!line.includes(" PRIVMSG #")) continue;
      const parsed = parsePrivmsg(line);
      if (!parsed) continue;

      const htmlParts = buildMessageHtmlParts(parsed.text, parsed.emotesTag);
      addMessage(cfg, parsed.name, parsed.color, htmlParts, parsed.badgeImgs);
    }
  });

  ws.addEventListener("close", () => {
    updateDebugBanner(cfg, "Disconnected — retrying in 2s…");
    setTimeout(() => connectIrc(cfg), 2000);
  });

  ws.addEventListener("error", () => {
    updateDebugBanner(cfg, "WebSocket error (network/CSP).");
  });
}

function parsePrivmsg(line) {
  let tags = {};
  let rest = line;

  if (rest.startsWith("@")) {
    const spaceIdx = rest.indexOf(" ");
    const rawTags = rest.slice(1, spaceIdx);
    tags = parseTags(rawTags);
    rest = rest.slice(spaceIdx + 1);
  }

  const msgIdx = rest.indexOf(" :");
  if (msgIdx === -1) return null;

  const text = rest.slice(msgIdx + 2);
  const name = tags["display-name"] || "Unknown";
  const color = tags["color"] || "#ffffff";
  const emotesTag = tags["emotes"] || "";

  // badges tag: "moderator/1,subscriber/6"
  const badgeTag = tags["badges"] || "(none)";
  const badgeImgs = (STATE.cfg?.badgeProxy && STATE.badgesReady && badgeTag && badgeTag !== "(none)")
    ? badgeUrlsFromTag(badgeTag)
    : [];

  return { name, color, text, emotesTag, badgeImgs };
}

function parseTags(raw) {
  const out = {};
  for (const p of raw.split(";")) {
    const eq = p.indexOf("=");
    const k = eq === -1 ? p : p.slice(0, eq);
    const v = eq === -1 ? "" : p.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

function badgeUrlsFromTag(badgeTag) {
  // Reads from STATE maps (loaded by badges.js)
  const urls = [];
  const parts = String(badgeTag).split(",").filter(Boolean);

  for (const p of parts) {
    const [setId, ver] = p.split("/");
    if (!setId || !ver) continue;

    const chan = STATE.badgeMapChannel.get(setId);
    const glob = STATE.badgeMapGlobal.get(setId);

    const url = (chan?.get(ver)) || (glob?.get(ver));
    if (url) urls.push(url);
  }

  return urls;
}
