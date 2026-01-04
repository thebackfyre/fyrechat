/* fyrechat.js
   FyreChat: configurable Twitch chat overlay
   - Loads defaults from ./assets/config/fyrechat.default.json
   - Deep-merges config with URI overrides
   - IRC websocket (anon) for chat messages
   - Twitch emotes via IRC tags
   - Badges via Cloudflare Worker proxy (badgeProxy)
   - BTTV + 7TV emotes (optional) with simple caching
*/

(() => {
  // -----------------------------
  // 0) Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

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
  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function deepMerge(base, patch) {
    // merges patch into base (non-mutating)
    if (patch == null) return structuredClone(base);
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const bv = base && typeof base === "object" ? base[k] : undefined;
        out[k] = deepMerge(bv && typeof bv === "object" ? bv : {}, v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
    return await res.json();
  }

  // -----------------------------
  // 1) Config loading (defaults + URI)
  // -----------------------------
  const params = new URLSearchParams(location.search);

  const DEFAULT_FALLBACK = {
    channel: "alveussanctuary",
    max: 8,
    ttl: 22,
    fade: 2,
    debug: false,
    demo: false,
    demoBadges: false,
    theme: "glass",
    badgeProxy: "https://twitch-badge-proxy.thebackfyre.workers.dev",
    emotes: {
      enabled: true,
      providers: {
        bttv: { enabled: true },
        "7tv": { enabled: true, baseUrl: "https://api.7tv.app/v3" }
      },
      cacheMinutes: 360
    }
  };

  function configFromUri() {
    // Keep URI override surface small and predictable
    const uri = {};

    if (params.has("ch")) uri.channel = String(params.get("ch") || "").toLowerCase();
    if (params.has("max")) uri.max = clampInt(params.get("max"), undefined, 1, 200);
    if (params.has("ttl")) uri.ttl = clampInt(params.get("ttl"), undefined, 0, 3600);
    if (params.has("fade")) uri.fade = clampFloat(params.get("fade"), undefined, 0, 30);

    if (params.get("debug") === "1") uri.debug = true;
    if (params.get("debug") === "0") uri.debug = false;

    if (params.get("demo") === "1") uri.demo = true;
    if (params.get("demo") === "0") uri.demo = false;

    if (params.get("demoBadges") === "1") uri.demoBadges = true;
    if (params.get("demoBadges") === "0") uri.demoBadges = false;

    if (params.has("theme")) uri.theme = String(params.get("theme") || "");

    // Emotes quick toggles
    if (params.get("emotes") === "0") uri.emotes = { enabled: false };
    if (params.get("emotes") === "1") uri.emotes = { enabled: true };

    return uri;
  }

  // -----------------------------
  // 2) DOM refs
  // -----------------------------
  const $debug = $("debug");
  const $stack = $("stack");
  const $themeLink = document.getElementById("themeLink");

  // -----------------------------
  // 3) Badge + emote state (caches)
  // -----------------------------
  const badgeState = {
    ready: false,
    globalSets: {},     // badgeSetName -> versions map
    channelSets: {},    // badgeSetName -> versions map
  };

  // name -> { url, provider }
  const thirdPartyEmotes = new Map();

  // Simple in-memory cache for this session
  const sessionCache = new Map(); // key -> { atMs, data }

  function cacheGet(key, maxAgeMs) {
    const hit = sessionCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.atMs > maxAgeMs) return null;
    return hit.data;
  }
  function cacheSet(key, data) {
    sessionCache.set(key, { atMs: Date.now(), data });
  }

  // -----------------------------
  // 4) Debug banner
  // -----------------------------
  function setDebug(on, text) {
    if (!on) {
      $debug.style.display = "none";
      return;
    }
    $debug.style.display = "block";
    $debug.textContent = text;
  }

  function debugLine(cfg, extra = "") {
    const parts = [
      cfg.demo ? "DEMO" : "IRC",
      `ch=${cfg.channel}`,
      `max=${cfg.max}`,
      `ttl=${cfg.ttl}s`,
      `fade=${cfg.fade}s`,
      `badges=${cfg.badgeProxy ? "on" : "off"}`,
      `emotes=${cfg.emotes?.enabled ? "on" : "off"}`,
      extra
    ].filter(Boolean);
    return parts.join(" | ");
  }

  // -----------------------------
  // 5) Theme selection
  // -----------------------------
  function applyTheme(cfg) {
    if (!$themeLink) return;
    // Very simple: map "glass" -> ./assets/themes/glass.css
    // If you add more themes, keep file name = theme name.
    const theme = (cfg.theme || "glass").trim();
    $themeLink.href = `./assets/themes/${theme}.css`;
  }

  // -----------------------------
  // 6) Twitch IRC parsing
  // -----------------------------
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

    // badges tag looks like: "moderator/1,subscriber/12"
    const badges = tags["badges"] || "";
    const emotes = tags["emotes"] || "";

    return { name, color, text, badges, emotes };
  }

  // -----------------------------
  // 7) Emote rendering
  // -----------------------------
  function buildTwitchEmoteRanges(emotesTag) {
    // returns ranges: [{start,end,id}]
    if (!emotesTag) return [];
    const ranges = [];
    for (const def of emotesTag.split("/").filter(Boolean)) {
      const [id, locs] = def.split(":");
      if (!id || !locs) continue;
      for (const loc of locs.split(",")) {
        const [startStr, endStr] = loc.split("-");
        const start = Number(startStr), end = Number(endStr);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          ranges.push({ start, end, id });
        }
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    return ranges;
  }

  function messageHtmlPartsWithTwitchEmotes(text, emotesTag) {
    const ranges = buildTwitchEmoteRanges(emotesTag);
    if (!ranges.length) return [escapeHtml(text)];

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

  function applyThirdPartyEmotesToHtml(htmlSafeText) {
    // htmlSafeText is *already escaped* (except existing <img> tags).
    // We will do a conservative token replace only on plain text segments.
    // Because we already build Twitch emotes by inserting <img>, the safest approach:
    // - Split on <img ...> and only replace in text pieces.
    const chunks = htmlSafeText.split(/(<img[^>]*>)/g);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].startsWith("<img")) continue;

      // Replace emote codes as whole words
      // (simple and fast; upgrade later if you want punctuation/edge rules)
      const words = chunks[i].split(/(\s+)/);
      for (let w = 0; w < words.length; w++) {
        const token = words[w];
        if (!token || token.trim() === "") continue;

        // token is escaped; emote names are plain; compare raw token string
        const hit = thirdPartyEmotes.get(token);
        if (hit) {
          words[w] = `<img class="emote" alt="" src="${hit.url}">`;
        }
      }
      chunks[i] = words.join("");
    }
    return chunks.join("");
  }

  // -----------------------------
  // 8) Badge rendering
  // -----------------------------
  function parseBadgeList(badgesTag) {
    // "moderator/1,subscriber/12" -> [{set:"moderator",ver:"1"}, ...]
    if (!badgesTag) return [];
    return badgesTag.split(",").filter(Boolean).map((pair) => {
      const [set, ver] = pair.split("/");
      return { set, ver };
    }).filter(x => x.set && x.ver);
  }

  function badgeUrlFromSets(setName, version) {
    // Prefer channel set, fallback to global
    const ch = badgeState.channelSets?.[setName]?.[version];
    if (ch?.image_url_1x) return ch.image_url_1x;

    const gl = badgeState.globalSets?.[setName]?.[version];
    if (gl?.image_url_1x) return gl.image_url_1x;

    return null;
  }

  function buildBadgesHtml(badgesTag) {
    const list = parseBadgeList(badgesTag);
    if (!list.length) return "";

    const imgs = [];
    for (const b of list) {
      const url = badgeUrlFromSets(b.set, b.ver);
      if (!url) continue;
      imgs.push(`<img class="badge" alt="" src="${url}">`);
    }
    return imgs.join("");
  }

  // -----------------------------
  // 9) Rendering bubbles
  // -----------------------------
  function addMessage(cfg, msg) {
    const el = document.createElement("div");
    el.className = "msg";

    const meta = document.createElement("div");
    meta.className = "meta";

    // Badges (images) in front of the name
    if (cfg.badgeProxy && badgeState.ready) {
      const badgesHtml = buildBadgesHtml(msg.badges);
      if (badgesHtml) {
        const badgeWrap = document.createElement("span");
        badgeWrap.className = "badges";
        badgeWrap.innerHTML = badgesHtml;
        meta.appendChild(badgeWrap);
      }
    }

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = msg.name;
    nameEl.style.color = msg.color || "#fff";

    const textEl = document.createElement("div");
    textEl.className = "text";

    // Twitch emotes first
    let html = messageHtmlPartsWithTwitchEmotes(msg.text, msg.emotes).join("");

    // Then third-party emotes (BTTV/7TV)
    if (cfg.emotes?.enabled && thirdPartyEmotes.size > 0) {
      html = applyThirdPartyEmotesToHtml(html);
    }

    textEl.innerHTML = html;

    meta.appendChild(nameEl);
    el.appendChild(meta);
    el.appendChild(textEl);

    $stack.appendChild(el);

    // Keep stack <= max
    while ($stack.children.length > cfg.max) {
      $stack.removeChild($stack.firstChild);
    }

    // TTL removal
    if (cfg.ttl > 0) {
      const removeAtMs = cfg.ttl * 1000;
      const fadeMs = Math.max(0, (cfg.fade ?? 0) * 1000);

      if (fadeMs > 0 && removeAtMs > fadeMs) {
        setTimeout(() => el.classList.add("out"), removeAtMs - fadeMs);
        setTimeout(() => el.remove(), removeAtMs);
      } else {
        setTimeout(() => el.remove(), removeAtMs);
      }
    }
  }

  // -----------------------------
  // 10) Badge loading (via Worker)
  // -----------------------------
  async function loadBadges(cfg) {
    if (!cfg.badgeProxy) return;

    const base = cfg.badgeProxy.replace(/\/$/, "");
    const channelLogin = String(cfg.channel || "").toLowerCase();

    // Get Twitch user id via proxy
    // expected: GET /id?login=valkyrae -> { id: "79615025" } (or similar)
    const idKey = `twitch:id:${channelLogin}`;
    let channelId = cacheGet(idKey, 24 * 60 * 60 * 1000);
    if (!channelId) {
      const idJson = await fetchJson(`${base}/id?login=${encodeURIComponent(channelLogin)}`, { cache: "no-store" });
      channelId = idJson?.id || idJson?.data?.[0]?.id || null;
      if (channelId) cacheSet(idKey, channelId);
    }

    // Global badges
    const globalKey = "twitch:badges:global";
    let global = cacheGet(globalKey, 24 * 60 * 60 * 1000);
    if (!global) {
      global = await fetchJson(`${base}/badges/global`, { cache: "no-store" });
      cacheSet(globalKey, global);
    }

    // Channel badges
    let channel = null;
    if (channelId) {
      const channelKey = `twitch:badges:channel:${channelId}`;
      channel = cacheGet(channelKey, 24 * 60 * 60 * 1000);
      if (!channel) {
        channel = await fetchJson(`${base}/badges/channels/${encodeURIComponent(channelId)}`, { cache: "no-store" });
        cacheSet(channelKey, channel);
      }
    }

    // Normalize shape: {badge_sets:{ setName:{ versions:{ "1":{image_url_1x...}}}}}
     function normalizeBadgeSets(json) {
      const sets = json?.badge_sets || json?.data?.badge_sets || null;
      if (!sets) return {};

      const out = {};
      for (const [setName, setObj] of Object.entries(sets)) {
        const versions = setObj?.versions;

        // Twitch returns versions as an ARRAY: [{ id:"1", image_url_1x... }, ...]
        // Convert to a map keyed by version id: { "1": { ... }, ... }
        if (Array.isArray(versions)) {
          const map = {};
          for (const v of versions) {
            if (v?.id != null) map[String(v.id)] = v;
          }
          out[setName] = map;
          continue;
        }

        // Some proxies/variants might already be a map
        if (versions && typeof versions === "object") {
          out[setName] = versions;
          continue;
        }

        out[setName] = {};
      }

      return out;
    }


    badgeState.globalSets = normalizeBadgeSets(global);
    badgeState.channelSets = normalizeBadgeSets(channel);
    badgeState.ready = true;
  }

  // -----------------------------
  // 11) Third-party emotes (BTTV + 7TV)
  // -----------------------------
  async function loadThirdPartyEmotes(cfg) {
    if (!cfg.emotes?.enabled) return;

    const cacheMinutes = clampInt(cfg.emotes.cacheMinutes, 360, 1, 7 * 24 * 60);
    const maxAgeMs = cacheMinutes * 60 * 1000;

    const channelLogin = String(cfg.channel || "").toLowerCase();
    const base7 = cfg.emotes?.providers?.["7tv"]?.baseUrl || "https://api.7tv.app/v3";

    // Resolve Twitch user id via badge proxy if present (best), otherwise skip channel emotes for providers needing id.
    let channelId = null;
    if (cfg.badgeProxy) {
      const base = cfg.badgeProxy.replace(/\/$/, "");
      const idKey = `twitch:id:${channelLogin}`;
      channelId = cacheGet(idKey, 24 * 60 * 60 * 1000);
      if (!channelId) {
        try {
          const idJson = await fetchJson(`${base}/id?login=${encodeURIComponent(channelLogin)}`, { cache: "no-store" });
          channelId = idJson?.id || idJson?.data?.[0]?.id || null;
          if (channelId) cacheSet(idKey, channelId);
        } catch {
          // ok to continue without channelId
        }
      }
    }

    // BTTV
    if (cfg.emotes?.providers?.bttv?.enabled) {
      const keyG = "bttv:global";
      let global = cacheGet(keyG, maxAgeMs);
      if (!global) {
        global = await fetchJson("https://api.betterttv.net/3/cached/emotes/global", { cache: "no-store" });
        cacheSet(keyG, global);
      }
      for (const e of global || []) {
        // url schema: https://cdn.betterttv.net/emote/{id}/1x
        thirdPartyEmotes.set(e.code, { url: `https://cdn.betterttv.net/emote/${e.id}/1x`, provider: "bttv" });
      }

      if (channelId) {
        const keyC = `bttv:chan:${channelId}`;
        let chan = cacheGet(keyC, maxAgeMs);
        if (!chan) {
          // returns { channelEmotes:[], sharedEmotes:[] }
          chan = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(channelId)}`, { cache: "no-store" });
          cacheSet(keyC, chan);
        }
        const all = [...(chan?.channelEmotes || []), ...(chan?.sharedEmotes || [])];
        for (const e of all) {
          thirdPartyEmotes.set(e.code, { url: `https://cdn.betterttv.net/emote/${e.id}/1x`, provider: "bttv" });
        }
      }
    }

    // 7TV
    if (cfg.emotes?.providers?.["7tv"]?.enabled) {
      // Global set (best-effort; 7TV sometimes changes this endpoint behavior)
      const keyG = "7tv:global";
      let global = cacheGet(keyG, maxAgeMs);
      if (!global) {
        try {
          global = await fetchJson(`${base7}/emote-sets/global`, { cache: "no-store" });
          cacheSet(keyG, global);
        } catch {
          global = null;
        }
      }
      const globalEmotes = global?.emotes || global?.data?.emotes || [];
      for (const e of globalEmotes) {
        const url = pick7tvUrl(e);
        if (url) thirdPartyEmotes.set(e.name, { url, provider: "7tv" });
      }

      if (channelId) {
        const keyC = `7tv:chan:${channelId}`;
        let user = cacheGet(keyC, maxAgeMs);
        if (!user) {
          try {
            user = await fetchJson(`${base7}/users/twitch/${encodeURIComponent(channelId)}`, { cache: "no-store" });
            cacheSet(keyC, user);
          } catch {
            user = null;
          }
        }
        const emotes = user?.emote_set?.emotes || [];
        for (const e of emotes) {
          const url = pick7tvUrl(e);
          if (url) thirdPartyEmotes.set(e.name, { url, provider: "7tv" });
        }
      }
    }
  }

  function pick7tvUrl(emoteObj) {
    // 7TV URLs: emote.data.host.url + files
    // Example shape: e.data.host.files = [{name:"1x.webp", format:"WEBP"}...]
    const host = emoteObj?.data?.host;
    if (!host?.url || !Array.isArray(host.files)) return null;

    // Prefer 1x WEBP/PNG, fallback first file
    const preferred = host.files.find(f => /(^1x\.)/.test(f.name)) || host.files[0];
    if (!preferred?.name) return null;

    return `https:${host.url}/${preferred.name}`;
  }

  // -----------------------------
  // 12) Demo mode
  // -----------------------------
  function runDemo(cfg) {
    const samples = [
      { name: "Fyre", color: "#9bf", text: "Demo mode: bubbles, badges (optional), and emotes test 👋" },
      { name: "ModUser", color: "#6f6", text: "Try typing Kappa or a BTTV/7TV emote code if loaded." },
      { name: "Viewer", color: "#fc6", text: "If badges are enabled, demoBadges=1 can force a badge preview." },
      { name: "Backfyre", color: "#f9b", text: "Fast chat stress test: max stack + TTL should behave." },
    ];

    // Fake badges (only for demo preview)
    const fakeBadges = cfg.demoBadges
      ? "moderator/1,subscriber/12"
      : "";

    let i = 0;
    setInterval(() => {
      const s = samples[i++ % samples.length];
      addMessage(cfg, {
        name: s.name,
        color: s.color,
        text: s.text,
        badges: fakeBadges,
        emotes: "" // twitch emotes tag not present in demo
      });
    }, 900);
  }

  // -----------------------------
  // 13) Live IRC
  // -----------------------------
  function connectIrc(cfg) {
    const chan = String(cfg.channel || "").toLowerCase();
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const anonNick = "justinfan" + Math.floor(Math.random() * 80000 + 1000);

    ws.addEventListener("open", () => {
      setDebug(cfg.debug, `Connected ✅ as ${anonNick} (joining #${chan})`);
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

        addMessage(cfg, {
          name: parsed.name,
          color: parsed.color,
          text: parsed.text,
          badges: parsed.badges,
          emotes: parsed.emotes
        });
      }
    });

    ws.addEventListener("close", () => {
      setDebug(cfg.debug, "Disconnected — retrying in 2s…");
      setTimeout(() => connectIrc(cfg), 2000);
    });

    ws.addEventListener("error", () => {
      setDebug(cfg.debug, "WebSocket error (network/CSP).");
    });
  }

  // -----------------------------
  // 14) Boot
  // -----------------------------
  async function boot() {
    // Load default JSON config (and deep-merge into fallback)
    let fileCfg = {};
    try {
      fileCfg = await fetchJson("./assets/config/fyrechat.default.json", { cache: "no-store" });
    } catch (e) {
      // If fetch fails, we continue with fallback
      fileCfg = {};
    }

    // Merge order:
    // 1) fallback (hardcoded)
    // 2) file config (fyrechat.default.json)
    // 3) URI overrides
    const merged = deepMerge(DEFAULT_FALLBACK, fileCfg);
    const cfg = deepMerge(merged, configFromUri());

    // Normalize key settings (guarantee numbers)
    cfg.channel = String(cfg.channel || "alveussanctuary").toLowerCase();
    cfg.max = clampInt(cfg.max, 8, 1, 200);
    cfg.ttl = clampInt(cfg.ttl, 22, 0, 3600);
    cfg.fade = clampFloat(cfg.fade, 2, 0, 30);
    cfg.debug = Boolean(cfg.debug);
    cfg.demo = Boolean(cfg.demo);
    cfg.demoBadges = Boolean(cfg.demoBadges);

    applyTheme(cfg);
    setDebug(cfg.debug, debugLine(cfg, "loading…"));

    // Load badges + third-party emotes before running (best effort)
    const tasks = [];

    if (cfg.badgeProxy) {
      tasks.push(
        loadBadges(cfg).catch((e) => {
          badgeState.ready = false;
          if (cfg.debug) setDebug(true, debugLine(cfg, "badges=fail"));
        })
      );
    }

    if (cfg.emotes?.enabled) {
      tasks.push(
        loadThirdPartyEmotes(cfg).catch(() => {
          // non-fatal
        })
      );
    }

    await Promise.allSettled(tasks);

    // Update debug line now that we know what loaded
    let extra = [];
    extra.push(`badgeSets=${badgeState.ready ? "ready" : "off"}`);
    extra.push(`3pEmotes=${thirdPartyEmotes.size}`);

    setDebug(cfg.debug, debugLine(cfg, extra.join(", ")));

    // Start demo or live
    if (cfg.demo) runDemo(cfg);
    else connectIrc(cfg);
  }

  // Run
  boot();
})();
