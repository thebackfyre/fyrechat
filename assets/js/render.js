import { STATE } from "./state.js";
import { escapeHtml, escapeAttr } from "./utils.js";

export function initRenderDom() {
  STATE.$stack = document.getElementById("stack");
}

export function addMessage(cfg, name, color, htmlParts, badgeImgs = []) {
  const $stack = STATE.$stack;
  if (!$stack) return;

  const el = document.createElement("div");
  el.className = "msg";

  const meta = document.createElement("div");
  meta.className = "meta";

  // badges
  if (badgeImgs && badgeImgs.length) {
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
  textEl.innerHTML = htmlParts.join("");

  meta.appendChild(nameEl);
  el.appendChild(meta);
  el.appendChild(textEl);

  $stack.appendChild(el);

  // keep list tight
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

// Twitch emotes from IRC emotes tag + 3P in text segments
export function buildMessageHtmlParts(text, emotesTag) {
  if (!emotesTag) return [renderTextWith3PEmotes(text)];

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
      parts.push(renderTextWith3PEmotes(text.slice(cursor, r.start)));
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

export function renderTextWith3PEmotes(rawText) {
  const cfg = STATE.cfg;

  // Support cfg.emotes.enabled and tolerate legacy boolean cfg.emotes
  const emotesEnabled =
    cfg?.emotes === true ||
    (cfg?.emotes && typeof cfg.emotes === "object" && !!cfg.emotes.enabled);

  // If emotes off or not loaded, just escape and return
  if (!emotesEnabled || !STATE.emotesReady || !STATE.emoteMap3P || STATE.emoteMap3P.size === 0) {
    return escapeHtml(rawText);
  }

  // Tokenize on whitespace but keep the whitespace tokens
  const tokens = String(rawText).split(/(\s+)/);

  // punctuation that should stay outside the emote core
  const TRAIL_PUNCT = /[!?.,:;~]+$/;

  // Peel wrappers on the RAW token (not escaped HTML)
  function peelTokenRaw(tok) {
    // Quick path for exact <name> form (THIS is your failing case)
    const mAngle = tok.match(/^<([^<>]+)>$/);
    if (mAngle) {
      return { left: "<", core: mAngle[1], right: ">" };
    }

    const LEFT_SEQ = ["(", "[", "{", "<", '"', "'"];
    const RIGHT_SEQ = [")", "]", "}", ">", '"', "'"];

    let left = "";
    let right = "";
    let core = tok;

    // peel trailing punctuation first
    let punct = "";
    const pm = core.match(TRAIL_PUNCT);
    if (pm) {
      punct = pm[0];
      core = core.slice(0, -punct.length);
    }

    let changed = true;
    while (changed && core.length) {
      changed = false;

      for (const seq of LEFT_SEQ) {
        if (core.startsWith(seq)) {
          left += seq;
          core = core.slice(seq.length);
          changed = true;
          break;
        }
      }

      for (const seq of RIGHT_SEQ) {
        if (core.endsWith(seq)) {
          right = seq + right;
          core = core.slice(0, -seq.length);
          changed = true;
          break;
        }
      }
    }

    right = right + punct;
    return { left, core, right };
  }

  const out = tokens.map((tok) => {
    if (!tok) return tok;

    // whitespace stays as-is (safe)
    if (/^\s+$/.test(tok)) return tok;

    const { left, core, right } = peelTokenRaw(tok);
    if (!core) return escapeHtml(tok);

    // lookup (try exact, then lower)
    let em = STATE.emoteMap3P.get(core);
    if (!em) em = STATE.emoteMap3P.get(core.toLowerCase());

    if (!em) return escapeHtml(tok);

    // Escape wrappers; emit img for emote
    return `${escapeHtml(left)}<img class="emote" alt="" src="${escapeAttr(em.url)}">${escapeHtml(right)}`;
  });

  return out.join("");
}
