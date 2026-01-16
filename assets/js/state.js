export const STATE = {
  cfg: null,

  // DOM
  $debug: null,
  $stack: null,

  // Twitch channel id
  channelId: null,
  channelIdErr: "",

  // Badges
  badgesReady: false,
  badgeErr: "",
  badgeMapGlobal: new Map(),   // set_id -> (version -> url)
  badgeMapChannel: new Map(),  // set_id -> (version -> url)

  // Emotes 3P
  emotesReady: false,
  emoteErr: "",
  emoteMap3P: new Map(), // name -> {url, provider}
};
