/* =========================================================
   FyreChat - main script
   File: fyrechat/assets/fyrechat.js

   Goals:
   - Load config JSON (default) + URI overrides (deep merge)
   - Twitch IRC chat bubbles
   - Badges via Cloudflare badge proxy
   - Emotes: Twitch (from IRC tags), BTTV + 7TV (global + channel)
   - Demo harness uses the SAME render pipeline as live
   ========================================================= */

(() => {
  // ----------------------------
  // DOM
  // ----------------------------
  const $debug = document.getElementById("debug");
  const $stack = document.getElementById("stack");

  // ----------------------------
  // URI params
  // ----------------------------
  const params = new URLSearchParams(location.search);

  // ----------------------------
  // Base defaults (safe fallback if config fails)
  // ----------------------------
  const BASE_DEFAULTS = {
    channel: "alveussanctuary",
    max: 8,
    ttl: 22,
    fade: 2,
    debug: false,

    demo: false,
    demoBadges: false,

    // Your worker/proxy that returns { data: [...] }
    badgeProxy: "https://twitch-badge-proxy.thebackfyre.workers.dev",

    theme: "glass",

    emotes: {
      enabled: true,
      providers: {
        bttv: { enabled: true },
        "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" },
        "ffz": { enabled: true, baseUrl: "https://api.frankerfacez.com/v1" }
      },
      cacheMinutes: 360
    }
  };

  // ----------------------------
  // Runtime state (loaded async)
  // ----------------------------
  const STATE = {
    cfg: null,

    // Twitch badge sets: set_id -> version_id -> image_url_1x
    badgeMapGlobal: new Map(),
    badgeMapChannel: new Map(),
    badgesReady: false,
    badgeErr: "",

    // Third-party emotes:
    // code -> { url, provider }
    emoteMap3P: new Map(),
    emotesReady: false,
    emoteErr: "",
    emoteCount: 0,

    // Channel ID for channel-scoped assets (badges/emotes)
    channelId: "",
    channelIdErr: ""
  };

  // ----------------------------
  // INIT
  // ----------------------------
  init().catch((err) => {
    console.error("FyreChat init fatal:", err);
    showDebug(`FyreChat init fatal: ${String(err && err.message ? err.message : err)}`, true);
  });

  async function init() {
    const cfg = await loadConfig();
    STATE.cfg = cfg;

    applyTheme(cfg);
    applyStyleVars(cfg);


    // Debug banner visibility
    if (cfg.debug) {
      $debug.style.display = "block";
      $debug.textContent = "Starting…";
    }

    // Resolve channel ID (needed for channel badges + channel emote sets)
    // This is intentionally tolerant: if it fails, globals can still work.
    STATE.channelId = await resolveTwitchUserId(cfg.channel).catch((e) => {
      STATE.channelIdErr = String(e && e.message ? e.message : e);
      return "";
    });

    // Load badges + emotes in parallel (non-blocking to chat, but we start after to keep demo reliable)
    const tasks = [];

    if (cfg.badgeProxy) tasks.push(loadBadges(cfg).catch((e) => {
      STATE.badgeErr = String(e && e.message ? e.message : e);
    }));

    if (cfg.emotes?.enabled) tasks.push(loadThirdPartyEmotes(cfg).catch((e) => {
      STATE.emoteErr = String(e && e.message ? e.message : e);
    }));

    await Promise.all(tasks);

    updateDebugBanner(cfg, "Ready");

    // Run demo or live
    if (cfg.demo) runDemo(cfg);
    else connectIrc(cfg, cfg.channel);
  }

  // =========================================================
  // Config loading + deep merge
  // =========================================================

  async function loadConfig() {
    // 1) Start from base defaults
    let cfg = structuredCloneSafe(BASE_DEFAULTS);

    // 2) Load default config JSON file (relative to fyrechat.html)
    const v = params.get("v") || String(Date.now());
    const url = `./assets/config/fyrechat.default.json?v=${encodeURIComponent(v)}`;

    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Config fetch failed: ${res.status} ${res.statusText}`);
      const json = await res.json();
      cfg = deepMerge(cfg, json);
    } catch (e) {
      // Not fatal; fall back to BASE_DEFAULTS
      console.warn("Config load failed, using BASE_DEFAULTS:", e);
    }

    // 3) Apply URI overrides (also deep merge where appropriate)
    cfg = applyUriOverrides(cfg);

    // Normalize/validate a few critical values
    cfg.channel = String(cfg.channel || "alveussanctuary").toLowerCase();
    cfg.max = clampInt(cfg.max, 8, 1, 200);
    cfg.ttl = clampInt(cfg.ttl, 22, 0, 3600);
    cfg.fade = clampFloat(cfg.fade, 2, 0, 30);
    cfg.debug = !!cfg.debug;
    cfg.demo = !!cfg.demo;
    cfg.demoBadges = !!cfg.demoBadges;

    // Ensure emotes object always exists (so code can depend on it)
    if (!cfg.emotes) cfg.emotes = structuredCloneSafe(BASE_DEFAULTS.emotes);

    return cfg;
  }

function applyUriOverrides(cfg) {
  // Simple scalar overrides
  if (params.has("ch")) cfg.channel = params.get("ch");
  if (params.has("max")) cfg.max = Number(params.get("max"));
  if (params.has("ttl")) cfg.ttl = Number(params.get("ttl"));
  if (params.has("fade")) cfg.fade = Number(params.get("fade"));
  if (params.has("debug")) cfg.debug = params.get("debug") === "1";
  if (params.has("demo")) cfg.demo = params.get("demo") === "1";
  if (params.has("demoBadges")) cfg.demoBadges = params.get("demoBadges") === "1";
  if (params.has("badgeProxy")) cfg.badgeProxy = params.get("badgeProxy");
  if (params.has("theme")) cfg.theme = params.get("theme");

  // Feature toggles
  // badges=0 or badges=1
  if (params.has("badges")) {
    const on = params.get("badges") === "1";
    if (!on) cfg.badgeProxy = "";
  }

  // emotes=0 or emotes=1
  if (params.has("emotes")) {
    const on = params.get("emotes") === "1";
    cfg.emotes = cfg.emotes || {};
    cfg.emotes.enabled = on;
  }

  // Provider toggles (optional)
  if (params.has("bttv")) {
    cfg.emotes = cfg.emotes || {};
    cfg.emotes.providers = cfg.emotes.providers || {};
    cfg.emotes.providers.bttv = cfg.emotes.providers.bttv || {};
    cfg.emotes.providers.bttv.enabled = params.get("bttv") === "1";
  }
  if (params.has("7tv")) {
    cfg.emotes = cfg.emotes || {};
    cfg.emotes.providers = cfg.emotes.providers || {};
    cfg.emotes.providers["7tv"] = cfg.emotes.providers["7tv"] || {};
    cfg.emotes.providers["7tv"].enabled = params.get("7tv") === "1";
  }
  if (params.has("ffz")) {
    cfg.emotes = cfg.emotes || {};
    cfg.emotes.providers = cfg.emotes.providers || {};
    cfg.emotes.providers.ffz = cfg.emotes.providers.ffz || {};
    cfg.emotes.providers.ffz.enabled = params.get("ffz") === "1";
  }

  // ---------------------------------------------------------
  // NEW: Style URI overrides -> cfg.style (so applyStyleVars works)
  // Example:
  //   &badgeSize=18px&badgeGap=6px&emoteSize=22px&emotePadX=2px
  // Optional nested aliases:
  //   &style.badgeSize=18px
  // ---------------------------------------------------------
  cfg.style = cfg.style || {};

  const get = (k) => {
    const v = params.get(k);
    return (v === null || v === "") ? null : v;
  };

  // Badge styling
  if (params.has("badgeSize") || params.has("style.badgeSize")) {
    cfg.style.badgeSize = get("badgeSize") ?? get("style.badgeSize") ?? cfg.style.badgeSize;
  }
  if (params.has("badgeGap") || params.has("style.badgeGap")) {
    cfg.style.badgeGap = get("badgeGap") ?? get("style.badgeGap") ?? cfg.style.badgeGap;
  }
  if (params.has("badgePadRight") || params.has("style.badgePadRight")) {
    cfg.style.badgePadRight = get("badgePadRight") ?? get("style.badgePadRight") ?? cfg.style.badgePadRight;
  }

  // Emote styling
  if (params.has("emoteSize") || params.has("style.emoteSize")) {
    cfg.style.emoteSize = get("emoteSize") ?? get("style.emoteSize") ?? cfg.style.emoteSize;
  }
  if (params.has("emoteBaseline") || params.has("style.emoteBaseline")) {
    cfg.style.emoteBaseline = get("emoteBaseline") ?? get("style.emoteBaseline") ?? cfg.style.emoteBaseline;
  }
  if (params.has("emotePadX") || params.has("style.emotePadX")) {
    cfg.style.emotePadX = get("emotePadX") ?? get("style.emotePadX") ?? cfg.style.emotePadX;
  }

  return cfg;
}


  function structuredCloneSafe(obj) {
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
  }

  function deepMerge(target, source) {
    if (!isObj(target) || !isObj(source)) return source;

    const out = Array.isArray(target) ? target.slice() : { ...target };

    for (const [k, v] of Object.entries(source)) {
      if (Array.isArray(v)) {
        out[k] = v.slice();
      } else if (isObj(v)) {
        out[k] = deepMerge(isObj(out[k]) ? out[k] : {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function isObj(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  // =========================================================
  // Theme
  // =========================================================

  function applyTheme(cfg) {
    const themeLink = document.getElementById("themeLink");
    if (!themeLink) return;

    // Map theme name -> css file (keep simple for now)
    // If user wants custom theme URIs later, we can support full URLs too.
    const theme = String(cfg.theme || "glass").toLowerCase();
    themeLink.href = `./assets/themes/${theme}.css`;
  }




// =========================================================
// Style Configs
// =========================================================

function applyStyleVars(cfg) {
  const s = cfg.style || {};
  const root = document.documentElement.style;

  const set = (name, val) => {
    if (val === undefined || val === null || val === "") return;
    root.setProperty(name, String(val));
  };

  set("--badgeSize", s.badgeSize);
  set("--badgeGap", s.badgeGap);
  set("--badgePadRight", s.badgePadRight);

  set("--emoteSize", s.emoteSize);
  set("--emoteBaseline", s.emoteBaseline);
  set("--emotePadX", s.emotePadX);
}





  // =========================================================
  // Twitch user id resolve (needed for channel badges/emotes)
  // =========================================================

  async function resolveTwitchUserId(login) {
    const l = String(login || "").trim().toLowerCase();
    if (!l) throw new Error("No channel login to resolve");

    // Use IVR (community) – no auth needed.
    // If this ever changes, we can swap to your own worker endpoint (later).
    const url = `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(l)}`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`IVR id lookup failed: ${res.status}`);

    const data = await res.json();
    // IVR returns an array for "user?login=" lookups
    const user = Array.isArray(data) ? data[0] : data;
    const id = user && (user.id || user.userId || user._id);

    if (!id) throw new Error("Could not parse channel id from IVR response");
    return String(id);
  }

  // =========================================================
  // Badges (global + channel)
  // Proxy returns: { data: [ { set_id, versions:[{id, image_url_1x,...}] } ] }
  // =========================================================

  async function loadBadges(cfg) {
    if (!cfg.badgeProxy) {
      STATE.badgesReady = false;
      return;
    }

    STATE.badgeErr = "";
    STATE.badgesReady = false;

    // Global
    const globalUrl = `${stripTrailingSlash(cfg.badgeProxy)}/badges/global`;
    const globalJson = await fetchJson(globalUrl);

    const gMap = parseBadgeSets(globalJson);
    STATE.badgeMapGlobal = gMap;

    // Channel (optional if id is known)
    if (STATE.channelId) {
      const chanUrl = `${stripTrailingSlash(cfg.badgeProxy)}/badges/channels/${encodeURIComponent(STATE.channelId)}`;
      const chanJson = await fetchJson(chanUrl);
      STATE.badgeMapChannel = parseBadgeSets(chanJson);
    } else {
      STATE.badgeMapChannel = new Map();
    }

    STATE.badgesReady = true;
  }

  function parseBadgeSets(json) {
    // Accept both shapes:
    // - direct: { badge_sets: {...} } (old Twitch format)
    // - proxy:  { data: [ ... ] }
    const out = new Map();

    if (json && json.badge_sets) {
      // Old/alt shape
      for (const [setId, setObj] of Object.entries(json.badge_sets)) {
        const versions = setObj && setObj.versions ? setObj.versions : {};
        for (const [verId, verObj] of Object.entries(versions)) {
          const url = verObj.image_url_1x || verObj.image_url_2x || verObj.image_url_4x;
          if (!url) continue;
          if (!out.has(setId)) out.set(setId, new Map());
          out.get(setId).set(verId, url);
        }
      }
      return out;
    }

    if (json && Array.isArray(json.data)) {
      for (const set of json.data) {
        const setId = set.set_id;
        if (!setId || !Array.isArray(set.versions)) continue;
        for (const v of set.versions) {
          const verId = String(v.id);
          const url = v.image_url_1x || v.image_url_2x || v.image_url_4x;
          if (!url) continue;
          if (!out.has(setId)) out.set(setId, new Map());
          out.get(setId).set(verId, url);
        }
      }
      return out;
    }

    // If neither shape matched, throw (so debug can show it)
    throw new Error("global badge_sets missing");
  }

  function badgeUrlsFromTag(badgesTag) {
    // badgesTag example: "moderator/1,subscriber/6"
    if (!badgesTag || badgesTag === "(none)") return [];

    const pairs = String(badgesTag).split(",").map(s => s.trim()).filter(Boolean);
    const urls = [];

    for (const p of pairs) {
      const [setId, verId] = p.split("/");
      if (!setId || !verId) continue;

      // Prefer channel-specific set first, then global
      const chanSet = STATE.badgeMapChannel.get(setId);
      const globSet = STATE.badgeMapGlobal.get(setId);

      const url =
        (chanSet && chanSet.get(verId)) ||
        (globSet && globSet.get(verId));

      if (url) urls.push(url);
    }
    return urls;
  }

 // =========================================================
// Third-party emotes (BTTV + 7TV)  [FFZ functions included, not called yet]
// =========================================================

async function loadThirdPartyEmotes(cfg) {
  STATE.emoteErr = "";
  STATE.emotesReady = false;
  STATE.emoteMap3P = new Map();
  STATE.emoteCount = 0;

  if (!cfg.emotes?.enabled) {
    STATE.emotesReady = false;
    return;
  }

  const providers = cfg.emotes.providers || {};
  const tasks = [];

  if (providers.bttv?.enabled) {
    tasks.push(
      loadBTTV(cfg).catch((e) => {
        console.warn("BTTV load failed:", e);
      })
    );
  }

  if (providers["7tv"]?.enabled) {
    tasks.push(
      load7TV(cfg).catch((e) => {
        console.warn("7TV load failed:", e);
      })
    );
  }

  // NOTE: FFZ is implemented below, but we are NOT calling it yet.
  // Next step (after you confirm this replacement compiles):
  if (providers.ffz?.enabled) tasks.push(loadFFZ(cfg).catch((e)=>console.warn("FFZ load failed:", e)));



  await Promise.all(tasks);

  STATE.emoteCount = STATE.emoteMap3P.size;
  STATE.emotesReady = true;
}

function set3PEmote(code, url, provider) {
  if (!code || !url) return;

  // "First wins" to avoid provider order surprises.
  // If you prefer "last wins", change to: STATE.emoteMap3P.set(code, {...})
  if (!STATE.emoteMap3P.has(code)) {
    STATE.emoteMap3P.set(code, { url, provider });
  }
}

async function loadBTTV(cfg) {
  // Global emotes
  const globalUrl = "https://api.betterttv.net/3/cached/emotes/global";
  const global = await fetchJson(globalUrl);

  for (const e of Array.isArray(global) ? global : []) {
    if (!e || !e.code || !e.id) continue;
    const url = `https://cdn.betterttv.net/emote/${e.id}/1x`;
    set3PEmote(e.code, url, "bttv:global");
  }

  // Channel emotes (requires twitch user id)
  if (STATE.channelId) {
    const chanUrl = `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(
      STATE.channelId
    )}`;
    const data = await fetchJson(chanUrl);

    // data.channelEmotes, data.sharedEmotes
    const all = []
      .concat(Array.isArray(data?.channelEmotes) ? data.channelEmotes : [])
      .concat(Array.isArray(data?.sharedEmotes) ? data.sharedEmotes : []);

    for (const e of all) {
      if (!e || !e.code || !e.id) continue;
      const url = `https://cdn.betterttv.net/emote/${e.id}/1x`;
      set3PEmote(e.code, url, "bttv:channel");
    }
  }
}

async function load7TV(cfg) {
  const baseUrl =
    cfg.emotes.providers["7tv"]?.baseUrl || "https://api.7tv.app/v3";
  const base = stripTrailingSlash(baseUrl);

  // Global emote set
  // 7TV v3: /emote-sets/global
  const globalSet = await fetchJson(`${base}/emote-sets/global`);
  add7TVSetEmotes(globalSet, "7tv:global");

  // Channel emote set (optional)
  // 7TV v3: /users/twitch/{id} -> has emote_set
  if (STATE.channelId) {
    const user = await fetchJson(
      `${base}/users/twitch/${encodeURIComponent(STATE.channelId)}`
    );
    if (user && user.emote_set) add7TVSetEmotes(user.emote_set, "7tv:channel");
  }
}

function add7TVSetEmotes(setObj, providerTag) {
  const emotes = Array.isArray(setObj?.emotes) ? setObj.emotes : [];

  for (const item of emotes) {
    // Shape: { name, data:{ id, host:{ url, files:[...] } } }
    const name = item?.name;
    const data = item?.data;
    const host = data?.host;

    if (!name || !host?.url || !Array.isArray(host.files)) continue;

    // Prefer 1x, otherwise any .webp, otherwise first
    const files = host.files;
    const file =
      files.find((f) => String(f.name).startsWith("1x")) ||
      files.find((f) => String(f.name).endsWith(".webp")) ||
      files[0];

    if (!file?.name) continue;

    // host.url is protocol-relative like //cdn.7tv.app/...
    const url = `https:${host.url}/${file.name}`;
    set3PEmote(name, url, providerTag);
  }
}

// =========================================================
// FFZ Emotes (Global + Channel)  
// =========================================================

async function loadFFZ(cfg) {
  const ffzCfg = cfg?.emotes?.providers?.ffz || {};
  if (!cfg?.emotes?.enabled || !ffzCfg.enabled) return;

  const baseUrl = ffzCfg.baseUrl || "https://api.frankerfacez.com/v1";
  const base = stripTrailingSlash(baseUrl);

  // Global: /set/global
  const global = await fetchJson(`${base}/set/global`);
  ingestFFZSets(global, "ffz:global");

  // Channel: /room/id/{twitchId}
  if (STATE.channelId) {
    const room = await fetchJson(
      `${base}/room/id/${encodeURIComponent(STATE.channelId)}`
    );
    ingestFFZSets(room, "ffz:channel");
  }
}

function ingestFFZSets(json, providerTag) {
  if (!json || !json.sets) return;

  const setsObj = json.sets || {};

  // Some payloads include default_sets for global
  const defaultSets = Array.isArray(json.default_sets) ? json.default_sets : [];

  // If default_sets exists, prioritize those; otherwise ingest everything.
  const setIdsToUse =
    defaultSets.length > 0 ? defaultSets.map(String) : Object.keys(setsObj);

  for (const setId of setIdsToUse) {
    const set = setsObj[String(setId)];
    if (!set?.emoticons) continue;
    ingestFFZEmoticons(set.emoticons, providerTag);
  }
}

function ingestFFZEmoticons(emoticons, providerTag) {
  if (!Array.isArray(emoticons)) return;

  for (const e of emoticons) {
    const code = e?.name;
    const urls = e?.urls;
    if (!code || !urls) continue;

    // Prefer highest available: "4" then "2" then "1"
    const rawUrl = urls["4"] || urls["2"] || urls["1"];
    const url = normalizeMaybeProtocolRelative(rawUrl);
    if (!url) continue;

    set3PEmote(code, url, providerTag);
  }
}

function normalizeMaybeProtocolRelative(url) {
  if (!url) return "";
  const s = String(url);
  if (s.startsWith("//")) return "https:" + s;
  return s;
}


  // =========================================================
  // IRC connection
  // =========================================================

  function connectIrc(cfg, chan) {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

    ws.addEventListener("open", () => {
      updateDebugBanner(cfg, `Connected as ${anonNick} (joining #${chan})`);
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

        // Build badges (if enabled/ready)
        const badgeImgs = (cfg.badgeProxy && STATE.badgesReady)
          ? badgeUrlsFromTag(parsed.badgesTag)
          : [];

        addMessage(cfg, parsed.name, parsed.color, parsed.htmlParts, badgeImgs);
      }
    });

    ws.addEventListener("close", () => {
      updateDebugBanner(cfg, "Disconnected — retrying in 2s…");
      setTimeout(() => connectIrc(cfg, chan), 2000);
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
    const emotes = tags["emotes"] || "";
    const badgesTag = tags["badges"] || "(none)";

    // Build html parts:
    // - Twitch emotes from positions in tag
    // - Then 3P emotes inside text segments
    const htmlParts = buildMessageHtmlParts(text, emotes);

    return { name, color, htmlParts, badgesTag };
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

  // =========================================================
  // Message rendering
  // - Twitch emotes: from IRC tag positions
  // - 3P emotes: token matching in text segments
  // =========================================================

  function buildMessageHtmlParts(text, emotesTag) {
    // If there are no Twitch emotes, just do 3P replacement over full text
    if (!emotesTag) {
      return [renderTextWith3PEmotes(text)];
    }

    const ranges = [];
    for (const def of emotesTag.split("/").filter(Boolean)) {
      const [id, locs] = def.split(":");
      if (!id || !locs) continue;
      for (const loc of locs.split(",")) {
        const [startStr, endStr] = loc.split("-");
        const start = Number(startStr), end = Number(endStr);
        if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end, id });
      }
    }

    if (!ranges.length) return [renderTextWith3PEmotes(text)];
    ranges.sort((a, b) => a.start - b.start);

    const parts = [];
    let cursor = 0;

    for (const r of ranges) {
      if (r.start > cursor) {
        const segment = text.slice(cursor, r.start);
        parts.push(renderTextWith3PEmotes(segment));
      }

      parts.push(
        `<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`
      );
      cursor = r.end + 1;
    }

    if (cursor < text.length) {
      parts.push(renderTextWith3PEmotes(text.slice(cursor)));
    }

    return parts;
  }

  function renderTextWith3PEmotes(rawText) {
  // If 3P emotes not enabled/ready, return escaped as-is
  const cfg = STATE.cfg;
  if (!cfg?.emotes?.enabled || !STATE.emotesReady || STATE.emoteMap3P.size === 0) {
    return escapeHtml(rawText);
  }

  const text = String(rawText ?? "");
  const parts = [];
  let i = 0;

  // Define what counts as an emote "word" character.
  // Most 3P codes are A-Z a-z 0-9 underscore.
  function isWordChar(ch) {
    const c = ch.charCodeAt(0);
    return (
      (c >= 48 && c <= 57) ||   // 0-9
      (c >= 65 && c <= 90) ||   // A-Z
      (c >= 97 && c <= 122) ||  // a-z
      ch === "_"
    );
  }

  while (i < text.length) {
    const ch = text[i];

    // Read a "word token"
    if (isWordChar(ch)) {
      const start = i;
      i++;
      while (i < text.length && isWordChar(text[i])) i++;
      const token = text.slice(start, i);

      const em = STATE.emoteMap3P.get(token);
      if (em?.url) {
        parts.push(`<img class="emote" alt="" src="${escapeAttr(em.url)}">`);
      } else {
        parts.push(escapeHtml(token));
      }
      continue;
    }

    // Non-word characters (spaces, punctuation, < >, quotes, emojis, etc.)
    // Emit as escaped text so it's safe, but preserved exactly.
    parts.push(escapeHtml(ch));
    i++;
  }

  return parts.join("");
}



  function escapeAttr(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  // =========================================================
  // UI: add message bubble + lifecycle
  // =========================================================

  function addMessage(cfg, name, color, htmlParts, badgeImgs) {
    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    // Badges (images) BEFORE name
    if (Array.isArray(badgeImgs) && badgeImgs.length) {
      for (const url of badgeImgs) {
        const img = document.createElement("img");
        img.className = "badge";
        img.alt = "";
        img.src = url;
        meta.appendChild(img);
      }
    }

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    nameEl.style.color = color || "#fff";

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.innerHTML = (htmlParts || []).join("");

    meta.appendChild(nameEl);
    el.appendChild(meta);
    el.appendChild(textEl);

    $stack.appendChild(el);

    // Keep stack tight
    while ($stack.children.length > cfg.max) $stack.removeChild($stack.firstChild);

    // TTL removal
    if (cfg.ttl > 0) {
      const removeAtMs = cfg.ttl * 1000;
      const fadeMs = Math.max(0, cfg.fade * 1000);

      if (fadeMs > 0 && removeAtMs > fadeMs) {
        setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
        setTimeout(() => el.remove(), removeAtMs);
      } else {
        setTimeout(() => el.remove(), removeAtMs);
      }
    }
  }

  // =========================================================
  // Demo harness (same render pipeline as live)
  // =========================================================

  function runDemo(cfg) {
    // IMPORTANT:
    // Demo does NOT receive Twitch IRC emote tags, so Twitch-native emotes
    // (Kappa/LUL/PogChamp etc.) won't render here.
    //
    // Demo IS a controlled harness for:
    // - Badge rendering (via demoBadges)
    // - 3P emotes (BTTV/7TV) including punctuation adjacency
    const samples = [
      { name: "Fyre",   color: "#9bf", text: "Badges before name 👋  (demoBadges=1 to force badges)" },
      { name: "Viewer", color: "#fc6", text: "FFZ: OMEGALUL monkaW AYAYA FeelsBadMan FeelsGoodMan" },
      { name: "ModUser",color: "#6f6", text: "BTTV globals: PepeLaugh monkaS (and punctuation: PepeLaugh, monkaS...)" },
      { name: "Viewer", color: "#fc6", text: "7TV globals: catJAM widepeepoHappy (and punctuation: catJAM? widepeepoHappy!)" },
      { name: "Fyre",   color: "#9bf", text: "MIX: PepeLaugh monkaS catJAM widepeepoHappy PepeLaugh!" },
      { name: "Viewer", color: "#fc6", text: "Edge: (PepeLaugh) [monkaS] {catJAM} <widepeepoHappy>" }
    ];

    const demoBadges = [
      "broadcaster/1",
      "moderator/1,subscriber/6",
      "subscriber/3",
      "vip/1",
      "(none)"
    ];

    let i = 0;
    setInterval(() => {
      const s = samples[i % samples.length];

      const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";
      const badgeImgs = (cfg.badgeProxy && STATE.badgesReady) ? badgeUrlsFromTag(badgeTag) : [];

      // Demo uses the SAME html building (except no Twitch emote ranges)
      const html = [renderTextWith3PEmotes(s.text)];

      addMessage(cfg, s.name, s.color, html, badgeImgs);
      i++;
    }, 1200);
  }

 // =========================================================
// Debug banner
// =========================================================

function updateDebugBanner(cfg, statusText) {
  if (!cfg.debug) return;

  const mode = cfg.demo ? "DEMO" : "IRC";

  const badgesOn = !!cfg.badgeProxy;
  const emotesOn = !!cfg.emotes?.enabled;

  const badgeSets = (badgesOn && STATE.badgesReady) ? "on" : "off";
  const badgeErr = STATE.badgeErr ? ` | badgeErr=${STATE.badgeErr}` : "";
  const idErr = STATE.channelIdErr ? ` | idErr=${STATE.channelIdErr}` : "";

  const emoteCount = STATE.emoteMap3P ? STATE.emoteMap3P.size : 0;

  // --- Emote provider flags ---
  const providers = cfg.emotes?.providers || {};
  const providerFlags = [
    providers.bttv?.enabled ? "BTTV" : null,
    providers["7tv"]?.enabled ? "7TV" : null,
    providers.ffz?.enabled ? "FFZ" : null
  ].filter(Boolean).join(",");

  // --- Style visibility (only show if overridden) ---
  const s = cfg.style || {};
  const styleBits = [];

  if (s.badgeSize) styleBits.push(`badge=${s.badgeSize}`);
  if (s.emoteSize) styleBits.push(`emote=${s.emoteSize}`);

  const styleText = styleBits.length
    ? ` | style(${styleBits.join(",")})`
    : "";

  $debug.textContent =
    `${mode} | ch=${cfg.channel} | max=${cfg.max} | ttl=${cfg.ttl}s | fade=${cfg.fade}s}` +
    ` | badges=${badgesOn ? "on" : "off"} | emotes=${emotesOn ? "on" : "off"}` +
    ` | badgeSets=${badgeSets}, 3pEmotes=${emoteCount}` +
    (providerFlags ? ` [${providerFlags}]` : "") +
    styleText +
    (statusText ? ` | ${statusText}` : "") +
    badgeErr + idErr;
}


  // =========================================================
  // Utilities
  // =========================================================

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
    return await res.json();
  }

  function stripTrailingSlash(s) {
    return String(s || "").replace(/\/+$/, "");
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.max(min, Math.min(max, i));
  }

  function clampFloat(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
})();
