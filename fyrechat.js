/* ============================================================================
  FyreChat — assets/fyrechat.js

  - Loads config (assets/config/fyrechat.default.json) + URI overrides (deep merge)
  - Connects to Twitch IRC (anonymous)
  - Renders message bubbles in a stack
  - Supports:
      * Twitch emotes (from IRC tags)
      * BTTV + 7TV emotes (optional, cached)
      * Twitch badges via your Cloudflare Worker badge proxy

  Notes:
  - 3P emote matching is CASE-SENSITIVE (as emote codes are).
    Example: catJAM ✅  CatJam ❌
=========================================================================== */

(() => {
  // ----------------------------
  // Helpers
  // ----------------------------
  const $ = (sel) => document.querySelector(sel);

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

  function parseBool(v, fallback = false) {
    if (v == null) return fallback;
    const s = String(v).toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return fallback;
  }

  // Deep merge plain objects (arrays overwrite)
  function deepMerge(base, patch) {
    const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
    if (!patch || typeof patch !== "object") return out;

    for (const [k, v] of Object.entries(patch)) {
      const a = out[k];
      const b = v;
      const aObj = a && typeof a === "object" && !Array.isArray(a);
      const bObj = b && typeof b === "object" && !Array.isArray(b);

      if (aObj && bObj) out[k] = deepMerge(a, b);
      else out[k] = b;
    }
    return out;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // ----------------------------
  // DOM refs
  // ----------------------------
  const $debug = $("#debug");
  const $stack = $("#stack");

  // ----------------------------
  // Config loading
  // ----------------------------
  const params = new URLSearchParams(location.search);

  function uriConfigPatch() {
    const patch = {};

    if (params.has("ch")) patch.channel = String(params.get("ch") || "").toLowerCase();
    if (params.has("max")) patch.max = clampInt(params.get("max"), 8, 1, 200);
    if (params.has("ttl")) patch.ttl = clampInt(params.get("ttl"), 22, 0, 3600);
    if (params.has("fade")) patch.fade = clampFloat(params.get("fade"), 2, 0, 30);

    if (params.has("debug")) patch.debug = parseBool(params.get("debug"), false);
    if (params.has("demo")) patch.demo = parseBool(params.get("demo"), false);
    if (params.has("demoBadges")) patch.demoBadges = parseBool(params.get("demoBadges"), false);

    // quick toggles
    if (params.has("badges")) patch.badges = { enabled: parseBool(params.get("badges"), true) };
    if (params.has("emotes")) patch.emotes = { enabled: parseBool(params.get("emotes"), true) };

    if (params.has("theme")) patch.theme = String(params.get("theme") || "");

    return patch;
  }

  async function loadDefaultConfig() {
    // This must match your repo structure: fyrechat/assets/config/fyrechat.default.json
    const url = new URL("./assets/config/fyrechat.default.json", location.href).toString();
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
      const json = await res.json();
      return json && typeof json === "object" ? json : {};
    } catch (e) {
      console.warn("[FyreChat] Failed to load default config:", e);
      return {};
    }
  }

  // ----------------------------
  // Debug
  // ----------------------------
  function setDebug(cfg, text) {
    if (!$debug) return;
    if (!cfg.debug) {
      $debug.style.display = "none";
      return;
    }
    $debug.style.display = "block";
    $debug.textContent = text;
  }

  // ----------------------------
  // Theme
  // ----------------------------
  function ensureThemeLink(cfg) {
    const themeLink = document.getElementById("themeLink");
    if (!themeLink) return;
    if (!cfg.theme) return;
    const href = new URL(`./assets/themes/${cfg.theme}.css`, location.href).toString();
    themeLink.setAttribute("href", href);
  }

  // ----------------------------
  // Badge system (via your proxy)
  // ----------------------------
  const badgeState = {
    enabled: true,
    proxyBase: "",
    mergedLookup: null, // lookup[set][ver] = url
    channelId: null,
    lastError: null
  };

  // Supports both:
  // A) { badge_sets: { setName: { versions: { "1": {image_url_1x...} } } } }
  // B) { data: [ { set_id, versions: [ { id, image_url_1x... } ] } ] }
  function normalizeBadgeSets(apiResponse) {
    if (!apiResponse || typeof apiResponse !== "object") return null;

    const badgeSetsObj = apiResponse.badge_sets || apiResponse.badgeSets;
    if (badgeSetsObj && typeof badgeSetsObj === "object" && !Array.isArray(badgeSetsObj)) {
      const lookup = {};
      for (const [setName, setObj] of Object.entries(badgeSetsObj)) {
        const versions = setObj?.versions;
        if (!versions || typeof versions !== "object") continue;
        lookup[setName] = {};
        for (const [ver, info] of Object.entries(versions)) {
          const url = info?.image_url_2x || info?.image_url_1x || info?.image_url_4x || "";
          if (url) lookup[setName][String(ver)] = url;
        }
      }
      return Object.keys(lookup).length ? lookup : null;
    }

    const dataArr = apiResponse.data;
    if (Array.isArray(dataArr)) {
      const lookup = {};
      for (const set of dataArr) {
        const setName = set?.set_id;
        const versions = set?.versions;
        if (!setName || !Array.isArray(versions)) continue;
        lookup[setName] = {};
        for (const v of versions) {
          const ver = v?.id;
          const url = v?.image_url_2x || v?.image_url_1x || v?.image_url_4x || "";
          if (ver && url) lookup[setName][String(ver)] = url;
        }
      }
      return Object.keys(lookup).length ? lookup : null;
    }

    return null;
  }

  async function resolveChannelIdViaProxy(proxyBase, channelLogin) {
    const tries = [
      `${proxyBase}/id/${encodeURIComponent(channelLogin)}`,
      `${proxyBase}/id?login=${encodeURIComponent(channelLogin)}`,
      `${proxyBase}/user/${encodeURIComponent(channelLogin)}`,
      `${proxyBase}/users/${encodeURIComponent(channelLogin)}`
    ];

    for (const url of tries) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const txt = await res.text();

        const asNum = txt.trim().match(/^\d+$/) ? txt.trim() : null;
        if (asNum) return asNum;

        const j = safeJsonParse(txt);
        if (j) {
          const candidates = [
            j.id, j.user_id, j.userId,
            j.data?.id, j.data?.user_id, j.data?.userId
          ].filter(Boolean);

          for (const c of candidates) {
            const s = String(c).trim();
            if (s.match(/^\d+$/)) return s;
          }
        }
      } catch {
        // keep trying
      }
    }
    return null;
  }

  async function loadBadgesIfEnabled(cfg) {
    badgeState.proxyBase = (cfg.badgeProxy || "").replace(/\/+$/, "");
    badgeState.enabled = cfg.badges?.enabled ?? true;

    if (!badgeState.enabled) {
      badgeState.mergedLookup = null;
      return { ok: false, reason: "badges disabled" };
    }
    if (!badgeState.proxyBase) {
      badgeState.mergedLookup = null;
      return { ok: false, reason: "badgeProxy missing" };
    }

    try {
      // Global
      const globalJson = await fetchJson(`${badgeState.proxyBase}/badges/global`);
      const globalLookup = normalizeBadgeSets(globalJson);
      if (!globalLookup) throw new Error("global badge_sets missing");

      // Channel
      let channelLookup = {};
      const channelId = await resolveChannelIdViaProxy(badgeState.proxyBase, cfg.channel);
      badgeState.channelId = channelId;

      if (channelId) {
        const channelJson = await fetchJson(`${badgeState.proxyBase}/badges/channels/${channelId}`);
        const chLookup = normalizeBadgeSets(channelJson);
        if (chLookup) channelLookup = chLookup;
      }

      badgeState.mergedLookup = deepMerge(globalLookup, channelLookup);
      badgeState.lastError = null;
      return { ok: true, channelId: badgeState.channelId };
    } catch (e) {
      badgeState.lastError = String(e?.message || e);
      badgeState.mergedLookup = null;
      return { ok: false, reason: badgeState.lastError };
    }
  }

  function badgeUrlsFromTag(badgesTag) {
    if (!badgesTag || badgesTag === "(none)") return [];
    const lookup = badgeState.mergedLookup;
    if (!lookup) return [];

    const out = [];
    const parts = String(badgesTag).split(",").map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const [setName, version] = p.split("/");
      if (!setName || !version) continue;
      const url = lookup?.[setName]?.[version];
      if (url) out.push({ setName, version, url });
    }
    return out;
  }

  // ----------------------------
  // 3rd party emotes (BTTV + 7TV)
  // ----------------------------
  const emoteState = {
    enabled: true,
    cacheMinutes: 360,
    providers: {
      bttv: { enabled: true },
      "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" }
    },
    channel: "",
    map: new Map(),
    lastError: null
  };

  function loadEmoteCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      return j;
    } catch {
      return null;
    }
  }

  function saveEmoteCache(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
  }

  async function fetchBTTVEmotes() {
    const out = [];

    // Global
    try {
      const g = await fetchJson("https://api.betterttv.net/3/cached/emotes/global");
      for (const e of g || []) {
        if (e?.code && e?.id) {
          out.push({ name: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x` });
        }
      }
    } catch {}

    // Channel (needs Twitch channelId)
    try {
      const channelId = badgeState.channelId;
      if (!channelId) return out;

      const c = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
      const all = []
        .concat(c?.channelEmotes || [])
        .concat(c?.sharedEmotes || []);

      for (const e of all) {
        if (e?.code && e?.id) {
          out.push({ name: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x` });
        }
      }
    } catch {}

    return out;
  }

  async function fetch7TVEmotes(baseUrl) {
    const out = [];
    try {
      const channelId = badgeState.channelId;
      if (!channelId) return out;

      const url = `${baseUrl.replace(/\/+$/, "")}/users/twitch/${channelId}`;
      const data = await fetchJson(url);

      const emotes = data?.emote_set?.emotes || [];
      for (const item of emotes) {
        const name = item?.name;
        const host = item?.data?.host;
        const files = host?.files || [];
        const f =
          files.find(x => x?.name === "1x.webp") ||
          files.find(x => String(x?.name || "").includes("1x")) ||
          files[0];

        if (!name || !host?.url || !f?.name) continue;
        const imgUrl = `https:${host.url}/${f.name}`;
        out.push({ name, url: imgUrl });
      }
    } catch {}
    return out;
  }

  async function load3pEmotesIfEnabled(cfg) {
    emoteState.enabled = cfg.emotes?.enabled ?? true;
    emoteState.cacheMinutes = clampInt(cfg.emotes?.cacheMinutes, 360, 1, 365 * 24 * 60);
    emoteState.providers = deepMerge(emoteState.providers, cfg.emotes?.providers || {});
    emoteState.channel = cfg.channel;
    emoteState.map.clear();
    emoteState.lastError = null;

    if (!emoteState.enabled) return { ok: false, count: 0, reason: "emotes disabled" };

    const cacheKey = `fyrechat:3pEmotes:${cfg.channel}`;
    const now = Date.now();

    const cached = loadEmoteCache(cacheKey);
    if (cached && cached.ts && Array.isArray(cached.entries)) {
      const ageMs = now - cached.ts;
      const maxAgeMs = emoteState.cacheMinutes * 60 * 1000;
      if (ageMs >= 0 && ageMs < maxAgeMs) {
        for (const [name, url] of cached.entries) {
          if (name && url) emoteState.map.set(name, url);
        }
        return { ok: true, count: emoteState.map.size, cached: true };
      }
    }

    try {
      if (emoteState.providers?.bttv?.enabled) {
        const bttv = await fetchBTTVEmotes();
        for (const e of bttv) if (e?.name && e?.url) emoteState.map.set(e.name, e.url);
      }

      if (emoteState.providers?.["7tv"]?.enabled) {
        const baseUrl = emoteState.providers["7tv"]?.baseUrl || "https://api.7tv.app/v3";
        const seven = await fetch7TVEmotes(baseUrl);
        for (const e of seven) if (e?.name && e?.url) emoteState.map.set(e.name, e.url);
      }

      const entries = [];
      for (const [name, url] of emoteState.map.entries()) entries.push([name, url]);
      saveEmoteCache(cacheKey, { ts: now, entries });

      return { ok: true, count: emoteState.map.size, cached: false };
    } catch (e) {
      emoteState.lastError = String(e?.message || e);
      return { ok: false, count: 0, reason: emoteState.lastError };
    }
  }

  // ----------------------------
  // 3P Emote replacement (LIVE + DEMO)
  // ----------------------------
  // We ONLY replace inside text segments (strings). Existing <img ...> parts are untouched.
  function apply3pEmotesToHtmlParts(htmlParts) {
    if (!emoteState.enabled || emoteState.map.size === 0) return htmlParts;

    const out = [];
    for (const part of htmlParts) {
      // If this chunk already contains an emote image, don’t touch it.
      if (part.includes('class="emote"') || part.includes("<img")) {
        out.push(part);
        continue;
      }
      out.push(replaceThirdPartyEmotesInTextHtml(part));
    }
    return out;
  }

  // Core tokenizer fix:
  // - Keeps whitespace
  // - For each non-space token, split into: prefix + core + suffix
  //   where core is [A-Za-z0-9_]+ and prefix/suffix can be punctuation including <>.
  function replaceThirdPartyEmotesInTextHtml(htmlEscapedText) {
    const chunks = htmlEscapedText.split(/(\s+)/);

    for (let i = 0; i < chunks.length; i++) {
      const token = chunks[i];
      if (!token || /^\s+$/.test(token)) continue;

      // Example tokens we want to handle:
      // "<widepeepoHappy>"  "PepeLaugh,"  "catJAM?"  "widepeepoHappy!!!"
      // We'll peel non-word chars around the emote code.
      const m = token.match(/^([^A-Za-z0-9_]*)([A-Za-z0-9_]+)([^A-Za-z0-9_]*)$/);
      if (!m) continue;

      const lead = m[1] || "";
      const core = m[2] || "";
      const tail = m[3] || "";

      const url = emoteState.map.get(core);
      if (!url) continue;

      // Replace the core only; keep original punctuation around it.
      chunks[i] = `${lead}<img class="emote" alt="" src="${url}">${tail}`;
    }

    return chunks.join("");
  }

  // ----------------------------
  // Twitch IRC parsing
  // ----------------------------
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

  // Twitch emotes come from IRC tags with character ranges
  function buildTwitchMessageHtmlParts(text, emotesTag) {
    if (!emotesTag) return [escapeHtml(text)];

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

    if (!ranges.length) return [escapeHtml(text)];
    ranges.sort((a, b) => a.start - b.start);

    const parts = [];
    let cursor = 0;

    for (const r of ranges) {
      if (r.start > cursor) parts.push(escapeHtml(text.slice(cursor, r.start)));

      parts.push(
        `<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`
      );

      cursor = r.end + 1;
    }

    if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
    return parts;
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
    const badges = tags["badges"] || "(none)";

    let htmlParts = buildTwitchMessageHtmlParts(text, emotes);
    htmlParts = apply3pEmotesToHtmlParts(htmlParts);

    const badgeImgs = badgeUrlsFromTag(badges);
    return { name, color, htmlParts, badgeImgs };
  }

  // ----------------------------
  // Rendering
  // ----------------------------
  function addMessage(cfg, name, color, htmlParts, badgeImgs = []) {
    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    // badges BEFORE name
    if (badgeImgs && badgeImgs.length) {
      for (const b of badgeImgs) {
        const img = document.createElement("img");
        img.className = "badge";
        img.alt = "";
        img.src = b.url;
        meta.appendChild(img);
      }
    }

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    nameEl.style.color = color || "#fff";

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.innerHTML = htmlParts.join("");

    meta.appendChild(nameEl);
    el.appendChild(meta);
    el.appendChild(textEl);

    $stack.appendChild(el);

    while ($stack.children.length > cfg.max) $stack.removeChild($stack.firstChild);

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

  // ----------------------------
  // Demo (controlled harness)
  // ----------------------------
  function runDemo(cfg) {
    // NOTE:
    // - Twitch word emotes (Kappa, etc.) won’t render in demo because those require Twitch IRC tag ranges.
    // - 3P emotes DO render in demo because we run the same 3P pipeline.

    const samples = [
      { name: "Fyre",    color: "#9bf", text: "Badges should show before the name 👋" },
      { name: "ModUser", color: "#6f6", text: "If badgeSets=on, you should see mod/sub badges." },
      { name: "Viewer",  color: "#fc6", text: "3P emotes should render in demo AND live." },

      // 1) Twitch emote WORDS (demo stays as text; live uses IRC emote ranges)
      { name: "Fyre", color: "#9bf", text: "Twitch words (demo text): Kappa LUL PogChamp BibleThump" },

      // 2) BTTV globals
      { name: "ModUser", color: "#6f6", text: "BTTV: monkaS PepeLaugh" },

      // 3) 7TV (these are case-sensitive)
      { name: "Viewer", color: "#fc6", text: "7TV: catJAM widepeepoHappy" },

      // 4) Punctuation / adjacency / brackets stress tests
      { name: "Fyre", color: "#9bf", text: "EDGE: <widepeepoHappy> <catJAM> <PepeLaugh>" },
      { name: "Fyre", color: "#9bf", text: "Punct: PepeLaugh! catJAM? widepeepoHappy, monkaS..." },

      // 5) Mixed
      { name: "Viewer", color: "#fc6", text: "MIX: monkaS PepeLaugh catJAM widepeepoHappy" }
    ];

    const demoBadges = [
      "broadcaster/1",
      "moderator/1,subscriber/6",
      "subscriber/3"
    ];

    let i = 0;
    setInterval(() => {
      const s = samples[i % samples.length];

      const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";
      const badgeImgs = badgeUrlsFromTag(badgeTag);

      // Demo pipeline: escape -> 3P replacement -> render
      let html = escapeHtml(s.text);
      html = replaceThirdPartyEmotesInTextHtml(html);

      addMessage(cfg, s.name, s.color, [html], badgeImgs);
      i++;
    }, 1100);
  }

  // ----------------------------
  // Live (Twitch IRC)
  // ----------------------------
  function connectIrc(cfg) {
    const chan = String(cfg.channel || "").toLowerCase();
    if (!chan) return;

    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

    ws.addEventListener("open", () => {
      setDebug(cfg, `Connected ✅ as ${anonNick} (joining #${chan})`);
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
        addMessage(cfg, parsed.name, parsed.color, parsed.htmlParts, parsed.badgeImgs);
      }
    });

    ws.addEventListener("close", () => {
      setDebug(cfg, "Disconnected — retrying in 2s…");
      setTimeout(() => connectIrc(cfg), 2000);
    });

    ws.addEventListener("error", () => {
      setDebug(cfg, "WebSocket error (network/CSP).");
    });
  }

  // ----------------------------
  // Boot
  // ----------------------------
  function debugEmotePresence(cfg) {
    if (!cfg.debug) return;

    // Quick sanity checks for the exact ones you’re testing
    const check = ["monkaS", "PepeLaugh", "catJAM", "widepeepoHappy"];
    const present = check.map(k => `${k}:${emoteState.map.has(k) ? "Y" : "n"}`).join(" ");
    console.log("[FyreChat] 3P emote presence:", present);

    // If something is missing, you’ll see it instantly in the console.
    // Example: widepeepoHappy might be channel-specific depending on sets.
  }

  async function boot() {
    const defaults = await loadDefaultConfig();
    const patch = uriConfigPatch();
    const cfg = deepMerge(defaults, patch);

    cfg.channel = String(cfg.channel || "alveussanctuary").toLowerCase();
    cfg.max = clampInt(cfg.max, 8, 1, 200);
    cfg.ttl = clampInt(cfg.ttl, 22, 0, 3600);
    cfg.fade = clampFloat(cfg.fade, 2, 0, 30);

    cfg.debug = !!cfg.debug;
    cfg.demo = !!cfg.demo;
    cfg.demoBadges = !!cfg.demoBadges;

    if (!cfg.badges) cfg.badges = {};
    if (cfg.badges.enabled == null) cfg.badges.enabled = true;

    ensureThemeLink(cfg);

    const badgeLoad = await loadBadgesIfEnabled(cfg);
    const emoteLoad = await load3pEmotesIfEnabled(cfg);

    debugEmotePresence(cfg);

    if (cfg.debug) {
      const badgeStatus = cfg.badges.enabled ? "on" : "off";
      const badgeSets = badgeState.mergedLookup ? "on" : "off";
      const badgeErr = badgeState.lastError ? ` | badgeErr=${badgeState.lastError}` : "";
      const demoOrLive = cfg.demo ? "DEMO" : "IRC";

      setDebug(
        cfg,
        `${demoOrLive} | ch=${cfg.channel} | max=${cfg.max} | ttl=${cfg.ttl}s | fade=${cfg.fade}s | badges=${badgeStatus} | emotes=${emoteState.enabled ? "on" : "off"} | badgeSets=${badgeSets}, 3pEmotes=${emoteState.map.size}${badgeErr}`
      );

      console.log("[FyreChat] cfg:", cfg);
      console.log("[FyreChat] badges:", badgeLoad);
      console.log("[FyreChat] emotes:", emoteLoad);
    }

    if (cfg.demo) runDemo(cfg);
    else connectIrc(cfg);
  }

  boot();
})();
