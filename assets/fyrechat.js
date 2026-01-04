/* ============================================================================
   FyreChat — assets/fyrechat.js
   - Loads config (assets/config/fyrechat.default.json) + URI overrides (deep merge)
   - Connects to Twitch IRC (anonymous)
   - Renders message bubbles in a stack
   - Supports:
       * Twitch emotes (from IRC tags)
       * BTTV + 7TV emotes (optional, cached)
       * Twitch badges via your Cloudflare Worker badge proxy
   ============================================================================ */

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

  // Deep merge plain objects (no arrays merge; arrays overwrite)
  function deepMerge(base, patch) {
    const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
    if (!patch || typeof patch !== "object") return out;

    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // ----------------------------
  // DOM refs
  // ----------------------------
  const $debug = $("#debug");
  const $stack = $("#stack");

  // Ensure debug banner exists (your HTML has it)
  if ($debug) {
    $debug.style.display = "none";
  }

  // ----------------------------
  // Config loading
  // ----------------------------
  const params = new URLSearchParams(location.search);

  // URI overrides (these win over default config)
  function uriConfigPatch() {
    const patch = {};

    if (params.has("ch")) patch.channel = String(params.get("ch") || "").toLowerCase();
    if (params.has("max")) patch.max = clampInt(params.get("max"), 8, 1, 200);
    if (params.has("ttl")) patch.ttl = clampInt(params.get("ttl"), 22, 0, 3600);
    if (params.has("fade")) patch.fade = clampFloat(params.get("fade"), 2, 0, 30);

    if (params.has("debug")) patch.debug = parseBool(params.get("debug"), false);
    if (params.has("demo")) patch.demo = parseBool(params.get("demo"), false);
    if (params.has("demoBadges")) patch.demoBadges = parseBool(params.get("demoBadges"), false);

    // Optional feature toggles via URI
    if (params.has("badges")) patch.badges = { enabled: parseBool(params.get("badges"), true) };
    if (params.has("emotes")) patch.emotes = { enabled: parseBool(params.get("emotes"), true) };

    if (params.has("theme")) patch.theme = String(params.get("theme") || "");

    return patch;
  }

  async function loadDefaultConfig() {
    // IMPORTANT: build URL relative to *this page*, not repo root
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
  // Badge system
  // ----------------------------
  // We build a map: badgeSets[set][version] = image_url_1x (or 2x)
  // Sources:
  // - global badge sets
  // - channel badge sets (needs broadcaster userId)
  const badgeState = {
    enabled: true,
    proxyBase: "",
    globalSets: null,   // { badge_sets: { set: { versions: { ... } } } }
    channelSets: null,
    mergedLookup: null, // { set: { version: url } }
    channelId: null,
    lastError: null
  };

  function normalizeBadgeSets(apiResponse) {
    // Twitch badges API response shape:
    // { badge_sets: { broadcaster: { versions: { "1": { image_url_1x... }}}}}
    if (!apiResponse || typeof apiResponse !== "object") return null;
    const root = apiResponse.badge_sets || apiResponse.badgeSets || null;
    if (!root || typeof root !== "object") return null;

    const lookup = {};
    for (const [setName, setObj] of Object.entries(root)) {
      const versions = setObj && setObj.versions ? setObj.versions : null;
      if (!versions || typeof versions !== "object") continue;

      lookup[setName] = {};
      for (const [ver, info] of Object.entries(versions)) {
        // Prefer 2x if you want sharper badges; 1x is fine too.
        const url = info.image_url_2x || info.image_url_1x || info.image_url_4x || "";
        if (url) lookup[setName][ver] = url;
      }
    }
    return lookup;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  }

  async function resolveChannelIdViaProxy(proxyBase, channelLogin) {
    // Robust: try multiple endpoints in case your worker differs
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
        // Could be plain "79615025"
        const asNum = txt.trim().match(/^\d+$/) ? txt.trim() : null;
        if (asNum) return asNum;

        const j = safeJsonParse(txt);
        if (j) {
          // Could be {id:"79615025"} or {data:{id:"..."}} etc
          const candidates = [
            j.id,
            j.user_id,
            j.userId,
            j.data?.id,
            j.data?.user_id,
            j.data?.userId
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
    // cfg.badgeProxy is your worker domain (required)
    // cfg.badges.enabled optional, defaults true if badgeProxy exists
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
      // 1) Global sets
      const globalUrl = `${badgeState.proxyBase}/badges/global`;
      const globalJson = await fetchJson(globalUrl);
      const globalLookup = normalizeBadgeSets(globalJson);
      if (!globalLookup) throw new Error("global badge_sets missing");

      // 2) Channel sets (requires channel ID)
      let channelLookup = {};
      const channelId = await resolveChannelIdViaProxy(badgeState.proxyBase, cfg.channel);
      badgeState.channelId = channelId;

      if (channelId) {
        const channelUrl = `${badgeState.proxyBase}/badges/channels/${channelId}`;
        const channelJson = await fetchJson(channelUrl);
        const chLookup = normalizeBadgeSets(channelJson);
        if (chLookup) channelLookup = chLookup;
      }

      // Merge: channel overrides global
      badgeState.mergedLookup = deepMerge(globalLookup, channelLookup);
      badgeState.lastError = null;

      return { ok: true, channelId: badgeState.channelId, sets: badgeState.mergedLookup };
    } catch (e) {
      badgeState.lastError = String(e?.message || e);
      badgeState.mergedLookup = null;
      return { ok: false, reason: badgeState.lastError };
    }
  }

  function badgeUrlsFromTag(badgesTag) {
    // badgesTag example: "moderator/1,subscriber/6"
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
    // Map: emoteName -> imageUrl
    map: new Map()
  };

  function loadEmoteCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      return j;
    } catch { return null; }
  }

  function saveEmoteCache(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
  }

  async function fetchBTTVChannelEmotes(channelLogin) {
    // BTTV channel endpoint needs Twitch user id normally.
    // Many setups use the legacy endpoint requiring userId, but that’s extra complexity.
    // We’ll use a public lookup through decapi ONLY if you want later.
    // For now: keep it simple: use BTTV "shared + global" via their global endpoint + channel endpoint if we can get ID.
    // If you already built a worker for id, we can reuse it to hit BTTV channel endpoint.
    const out = [];

    // Global
    try {
      const g = await fetchJson("https://api.betterttv.net/3/cached/emotes/global");
      for (const e of g || []) {
        if (e?.code && e?.id) out.push({ name: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x` });
      }
    } catch {}

    // Channel (needs userId)
    try {
      const channelId = badgeState.channelId; // we already resolve it for badges
      if (!channelId) return out;
      const c = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
      const all = []
        .concat(c?.channelEmotes || [])
        .concat(c?.sharedEmotes || []);
      for (const e of all) {
        if (e?.code && e?.id) out.push({ name: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/1x` });
      }
    } catch {}

    return out;
  }

  async function fetch7TVEmotes(channelLogin, baseUrl) {
    // 7TV “users” lookup requires Twitch userId typically, but we’ll try a login lookup pattern:
    // Best practice: use the 7TV user-by-platform endpoint:
    // GET /users/twitch/<twitchUserId>
    // We’ll reuse the resolved channelId (Twitch user id).
    const out = [];

    try {
      const channelId = badgeState.channelId;
      if (!channelId) return out;

      const url = `${baseUrl.replace(/\/+$/, "")}/users/twitch/${channelId}`;
      const data = await fetchJson(url);

      const set = data?.emote_set;
      const emotes = set?.emotes || [];
      for (const item of emotes) {
        const name = item?.name;
        const host = item?.data?.host;
        const files = host?.files || [];
        // choose a sensible 1x file
        const f = files.find(x => x?.name === "1x.webp") || files.find(x => x?.name?.includes("1x")) || files[0];
        if (!name || !host?.url || !f?.name) continue;
        const imgUrl = `https:${host.url}/${f.name}`;
        out.push({ name, url: imgUrl });
      }
    } catch {}

    return out;
  }

  async function load3pEmotesIfEnabled(cfg) {
    emoteState.enabled = cfg.emotes?.enabled ?? true;
    emoteState.cacheMinutes = clampInt(cfg.emotes?.cacheMinutes, 360, 1, 24 * 60 * 24);
    emoteState.providers = deepMerge(emoteState.providers, cfg.emotes?.providers || {});
    emoteState.channel = cfg.channel;

    emoteState.map.clear();

    if (!emoteState.enabled) return { ok: false, count: 0, reason: "emotes disabled" };

    const cacheKey = `fyrechat:3pEmotes:${cfg.channel}`;
    const now = Date.now();

    // Cache format: { ts, entries: [ [name,url], ... ] }
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

    // Fresh load
    const entries = [];

    if (emoteState.providers?.bttv?.enabled) {
      const bttv = await fetchBTTVChannelEmotes(cfg.channel);
      for (const e of bttv) {
        if (e?.name && e?.url) {
          emoteState.map.set(e.name, e.url);
        }
      }
    }

    if (emoteState.providers?.["7tv"]?.enabled) {
      const baseUrl = emoteState.providers["7tv"]?.baseUrl || "https://api.7tv.app/v3";
      const seven = await fetch7TVEmotes(cfg.channel, baseUrl);
      for (const e of seven) {
        if (e?.name && e?.url) {
          emoteState.map.set(e.name, e.url);
        }
      }
    }

    for (const [name, url] of emoteState.map.entries()) entries.push([name, url]);
    saveEmoteCache(cacheKey, { ts: now, entries });

    return { ok: true, count: emoteState.map.size, cached: false };
  }

  // Replace plain-text tokens with <img> for 3rd party emotes
  function apply3pEmotesToHtmlParts(htmlParts) {
    if (!emoteState.enabled || emoteState.map.size === 0) return htmlParts;

    // htmlParts is already escaped + contains Twitch <img class="emote">
    // We'll only replace in text segments (not inside existing tags)
    const out = [];

    for (const part of htmlParts) {
      if (part.includes("<img")) {
        out.push(part);
        continue;
      }

      // part is plain escaped text. Split by spaces, keep separators.
      const tokens = part.split(/(\s+)/);
      for (const t of tokens) {
        if (!t || t.trim() === "") {
          out.push(t);
          continue;
        }
        const url = emoteState.map.get(t);
        if (url) {
          out.push(`<img class="emote" alt="" src="${url}">`);
        } else {
          out.push(t);
        }
      }
    }
    return out;
  }

  // ----------------------------
  // Twitch IRC parsing (tags, emotes, badges)
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

    // Twitch emotes are positional ranges -> build html parts
    let htmlParts = buildTwitchMessageHtmlParts(text, emotes);

    // 3P emotes: swap tokens in the remaining text pieces
    htmlParts = apply3pEmotesToHtmlParts(htmlParts);

    const badgeImgs = badgeUrlsFromTag(badges);

    return { name, color, htmlParts, badgeImgs };
  }

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
      parts.push(`<img class="emote" alt="" src="https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0">`);
      cursor = r.end + 1;
    }
    if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));

    return parts;
  }

  // ----------------------------
  // Rendering
  // ----------------------------
  function setDebug(cfg, extra = "") {
    if (!$debug) return;
    if (!cfg.debug) {
      $debug.style.display = "none";
      return;
    }
    $debug.style.display = "block";
    $debug.textContent = extra;
  }

  function ensureThemeLink(cfg) {
    const themeLink = document.getElementById("themeLink");
    if (!themeLink) return;

    if (!cfg.theme) return;

    // Expect theme file: ./assets/themes/<theme>.css
    const href = new URL(`./assets/themes/${cfg.theme}.css`, location.href).toString();
    themeLink.setAttribute("href", href);
  }

  function addMessage(cfg, name, color, htmlParts, badgeImgs = []) {
    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    // Badges (left of name)
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

    // Keep list tight
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

  // ----------------------------
  // Demo mode
  // ----------------------------
  function runDemo(cfg) {
    const samples = [
      { name: "Fyre", color: "#9bf", text: "Demo chat bubble — readable and stable 👋" },
      { name: "ModUser", color: "#6f6", text: "Badges should appear left of the name when enabled." },
      { name: "Viewer", color: "#fc6", text: "Next: BTTV + 7TV emotes inside messages." }
    ];

    // If demoBadges=1, we’ll pretend these users have badges
    const demoBadges = [
      // Using common badge pairs; these only render if badge sets loaded
      "broadcaster/1",
      "moderator/1,subscriber/6",
      "subscriber/3"
    ];

    let i = 0;
    setInterval(() => {
      const s = samples[i % samples.length];
      const badgeTag = cfg.demoBadges ? demoBadges[i % demoBadges.length] : "(none)";
      const badgeImgs = badgeUrlsFromTag(badgeTag);

      addMessage(cfg, s.name, s.color, [escapeHtml(s.text)], badgeImgs);
      i++;
    }, 1100);
  }

  // ----------------------------
  // Live mode (Twitch IRC)
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
  async function boot() {
    const defaults = await loadDefaultConfig();
    const patch = uriConfigPatch();

    // If your json doesn’t have cfg.badges.enabled, we treat badges as enabled when badgeProxy exists
    const cfg = deepMerge(defaults, patch);

    // Normalize core config with safe limits
    cfg.channel = String(cfg.channel || "alveussanctuary").toLowerCase();
    cfg.max = clampInt(cfg.max, 8, 1, 200);
    cfg.ttl = clampInt(cfg.ttl, 22, 0, 3600);
    cfg.fade = clampFloat(cfg.fade, 2, 0, 30);

    cfg.debug = !!cfg.debug;
    cfg.demo = !!cfg.demo;
    cfg.demoBadges = !!cfg.demoBadges;

    // Optional: create cfg.badges.enabled default
    if (!cfg.badges) cfg.badges = {};
    if (cfg.badges.enabled == null) cfg.badges.enabled = true;

    // Apply theme
    ensureThemeLink(cfg);

    // 1) Load badges (global + channel) FIRST (also resolves channelId we reuse for BTTV/7TV)
    const badgeLoad = await loadBadgesIfEnabled(cfg);

    // 2) Load 3P emotes (optional)
    const emoteLoad = await load3pEmotesIfEnabled(cfg);

    // Debug banner (single place that tells the truth)
    if (cfg.debug) {
      const badgeStatus = cfg.badges.enabled ? "on" : "off";
      const badgeSets = badgeState.mergedLookup ? "on" : "off";
      const badgeErr = badgeState.lastError ? ` | badgeErr=${badgeState.lastError}` : "";
      const demoOrLive = cfg.demo ? "DEMO" : "IRC";

      setDebug(
        cfg,
        `${demoOrLive} | ch=${cfg.channel} | max=${cfg.max} | ttl=${cfg.ttl}s | fade=${cfg.fade}s | badges=${badgeStatus} | emotes=${emoteState.enabled ? "on" : "off"} | badgeSets=${badgeSets}, 3pEmotes=${emoteState.map.size}${badgeErr}`
      );

      // Also log structured info once
      console.log("[FyreChat] cfg:", cfg);
      console.log("[FyreChat] badges:", badgeLoad);
      console.log("[FyreChat] emotes:", emoteLoad);
    }

    // Start mode
    if (cfg.demo) runDemo(cfg);
    else connectIrc(cfg);
  }

  boot();
})();
