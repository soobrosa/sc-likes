const USERNAME = 'soobrosa';
const MIX_KEYWORDS = /\b(mixtape|podcast|dj set|session|live at|live @|@ |b2b|boiler room|furnace|radio show|takeover|essential mix|rinse|nts)\b/i;
const MIX_KEYWORDS_NO_PARENS = /\b(mix|dj )\b/i;
const MIX_DURATION_MS = 30 * 60 * 1000;
const CACHE_KEY = 'sc-likes-tracks';
const COLLECTIONS_KEY = 'sc-likes-year-collections';
const CACHE_TTL_MS = 60 * 60 * 1000;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export async function cacheGet() {
  if (!UPSTASH_URL) return { tracks: null, stale: true };
  const res = await fetch(`${UPSTASH_URL}/get/${CACHE_KEY}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  if (!res.ok) return { tracks: null, stale: true };
  const { result } = await res.json();
  if (!result) return { tracks: null, stale: true };
  const data = JSON.parse(result);
  const age = Date.now() - (data.ts || 0);
  return { tracks: data.tracks, stale: age > CACHE_TTL_MS };
}

function slimTrack(t) {
  return {
    id: t.id,
    title: t.title,
    permalink_url: t.permalink_url,
    duration: t.duration,
    created_at: t.created_at,
    genre: t.genre,
    tag_list: t.tag_list,
    user: { username: t.user.username }
  };
}

export async function cacheSet(tracks) {
  if (!UPSTASH_URL) return;
  await fetch(`${UPSTASH_URL}/set/${CACHE_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify({ tracks: tracks.map(slimTrack), ts: Date.now() })
  });
}

async function redisCommand(command) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('Redis is not configured');
  }
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`Redis request failed (${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function parseCollections(raw) {
  if (!raw) return {};
  const collections = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return collections && typeof collections === 'object' && !Array.isArray(collections)
    ? collections
    : {};
}

export async function collectionsGet() {
  const raw = await redisCommand(['GET', COLLECTIONS_KEY]);
  return parseCollections(raw);
}

export async function collectionAdd(track) {
  const year = String(new Date(track.created_at).getFullYear());
  const item = {
    id: String(track.id),
    title: track.title,
    artist: track.user.username,
    url: track.permalink_url,
    meta: `${fmtDuration(track.duration)} · ${fmtDate(track.created_at)}`
  };
  const script = `
    local raw = redis.call('GET', KEYS[1])
    local collections = {}
    if raw then collections = cjson.decode(raw) end
    local items = collections[ARGV[1]] or {}
    for _, item in ipairs(items) do
      if tostring(item.id) == ARGV[2] then return raw end
    end
    table.insert(items, cjson.decode(ARGV[3]))
    collections[ARGV[1]] = items
    local updated = cjson.encode(collections)
    redis.call('SET', KEYS[1], updated)
    return updated
  `;
  const raw = await redisCommand([
    'EVAL',
    script,
    1,
    COLLECTIONS_KEY,
    year,
    item.id,
    JSON.stringify(item)
  ]);
  return parseCollections(raw);
}

export async function getClientId() {
  const res = await fetch('https://soundcloud.com');
  const html = await res.text();
  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
  for (const url of scripts.slice(-3)) {
    const js = await (await fetch(url)).text();
    const match = js.match(/client_id:"([a-zA-Z0-9]+)"/);
    if (match) return match[1];
  }
  throw new Error('Could not extract client_id');
}

export async function fetchAllLikes(userId, clientId) {
  let url = `https://api-v2.soundcloud.com/users/${userId}/likes?limit=200&client_id=${clientId}`;
  const all = [];
  while (url) {
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    const tracks = (data.collection || []).filter(i => i.track).map(i => i.track);
    all.push(...tracks);
    url = data.next_href ? data.next_href + `&client_id=${clientId}` : null;
  }
  return all;
}

export async function fetchLikesFromSoundCloud() {
  const clientId = await getClientId();
  const userRes = await fetch(`https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/${USERNAME}&client_id=${clientId}`);
  const user = await userRes.json();
  return fetchAllLikes(user.id, clientId);
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MIN_MIX_DURATION_MS = 10 * 60 * 1000;

function hasMixKeyword(s) {
  if (!s) return false;
  if (MIX_KEYWORDS.test(s)) return true;
  const noParen = s.replace(/\([^)]*\)/g, '');
  if (MIX_KEYWORDS_NO_PARENS.test(noParen)) return true;
  return false;
}

export function isMix(t) {
  if (t.duration >= MIX_DURATION_MS) return true;
  if (t.duration < MIN_MIX_DURATION_MS) return false;
  if (hasMixKeyword(t.title)) return true;
  if (hasMixKeyword(t.genre)) return true;
  if (hasMixKeyword(t.tag_list)) return true;
  return false;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTrack(t, type) {
  const year = new Date(t.created_at).getFullYear();
  return `<li data-id="${t.id}" data-title="${esc(t.title)}" data-artist="${esc(t.user.username)}" data-type="${type}" data-year="${year}">
    <a href="#" data-url="${esc(t.permalink_url)}" onclick="play(this);return false">
      <div class="track-title">${esc(t.title)}</div>
      <div class="track-artist">${esc(t.user.username)}</div>
      <div class="track-meta">${fmtDuration(t.duration)} &middot; ${fmtDate(t.created_at)}</div>
    </a>
  </li>`;
}

function groupByYear(taggedTracks) {
  const groups = {};
  for (const { track, type } of taggedTracks) {
    const y = new Date(track.created_at).getFullYear();
    if (!groups[y]) groups[y] = [];
    groups[y].push({ track, type });
  }
  return Object.keys(groups).sort((a, b) => b - a).map(y => ({ year: y, items: groups[y] }));
}

function renderYearGroups(groups) {
  return groups.map(g =>
    `<div class="year-group" data-year="${g.year}">
      <h3 class="year-header" id="y-${g.year}">${g.year} <span class="count">(${g.items.length})</span></h3>
      <ul>${g.items.map(i => renderTrack(i.track, i.type)).join('\n')}</ul>
    </div>`
  ).join('\n');
}

function yearNav(groups) {
  return groups.map(g =>
    `<a href="#y-${g.year}" class="year-link">${g.year}</a>`
  ).join(' ');
}

export function renderPage(mixes, songs) {
  const tagged = [
    ...mixes.map(t => ({ track: t, type: 'mix' })),
    ...songs.map(t => ({ track: t, type: 'song' }))
  ].sort((a, b) => new Date(b.track.created_at) - new Date(a.track.created_at));
  const groups = groupByYear(tagged);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>soobrosa likes</title>
<link href="https://fonts.googleapis.com/css2?family=Courier+Prime&family=Oswald:wght@400;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-padding-top: var(--top-h, 0px); }
  body { font-family: 'Courier Prime', monospace; background: #fff; color: #000; padding: 2rem; max-width: 1200px; margin: 0 auto; }

  .sticky-top { position: sticky; top: 0; z-index: 100; background: #fff; padding-bottom: 0.5rem; }
  .header { display: flex; align-items: center; gap: 1rem; padding: 0.4rem 0; }
  .header-left { flex-shrink: 0; }
  .header-right { flex: 1; min-width: 0; }
  h1 { font-family: 'Oswald', sans-serif; font-size: 2rem; text-transform: uppercase; letter-spacing: 0.1em; }

  .toolbar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .tabs { display: flex; gap: 0; }
  .tabs button { font-family: 'Oswald', sans-serif; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; background: none; border: 2px solid #000; padding: 0.2rem 0.6rem; cursor: pointer; color: #888; }
  .tabs button:not(:first-child) { margin-left: 0.4rem; }
  .tabs button.active { background: #000; color: #fff; }
  .tabs button:hover:not(.active) { background: #eee; }

  #search { font-family: 'Courier Prime', monospace; font-size: 0.8rem; border: 2px solid #000; padding: 0.2rem 0.5rem; flex: 1; min-width: 100px; max-width: 250px; outline: none; }
  #search:focus { border-color: #444; }
  #search::placeholder { color: #aaa; }

  .year-nav { font-size: 0.7rem; line-height: 1.6; margin-top: 0.3rem; }
  .year-nav a { color: #888; text-decoration: none; margin-right: 0.3rem; }
  .year-nav a:hover { color: #000; text-decoration: underline; }

  #player { display: none; margin-top: 0.5rem; border-bottom: 4px solid #000; padding-bottom: 0.5rem; }
  #player.visible { display: block; }
  .player-actions { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
  #collect-current { font-family: 'Oswald', sans-serif; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; background: #000; color: #fff; border: 2px solid #000; padding: 0.25rem 0.6rem; cursor: pointer; }
  #collect-current:hover:not(:disabled) { background: #fff; color: #000; }
  #collect-current:disabled { background: #ddd; border-color: #ddd; color: #777; cursor: default; }
  #collect-status { font-size: 0.7rem; color: #666; }
  #player iframe { display: none; width: 100%; height: 125px; border: none; }
  #player iframe.active { display: block; }

  #collections { margin: 1.5rem 0 2rem; border: 2px solid #000; padding: 1rem; }
  #collections[hidden] { display: none; }
  #collections h2 { font-family: 'Oswald', sans-serif; font-size: 1.1rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.75rem; }
  .collection-year + .collection-year { margin-top: 1rem; }
  .collection-year h3 { font-family: 'Oswald', sans-serif; font-size: 1rem; border-bottom: 1px solid #000; margin-bottom: 0.5rem; }

  .year-group { margin-bottom: 2rem; }
  .year-header { font-family: 'Oswald', sans-serif; font-size: 1.2rem; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 2px solid #000; padding-bottom: 0.2rem; margin-bottom: 0.75rem; position: sticky; top: var(--top-h, 0px); background: #fff; z-index: 10; padding-top: 0.3rem; }
  .year-header .count { font-size: 0.8rem; font-weight: 400; color: #888; }

  ul { list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  li { padding: 0.75rem; cursor: pointer; border: 1px solid #eee; }
  li:hover { background: #f5f5f5; border-color: #ccc; }
  li a { color: #000; text-decoration: none; display: block; }
  li a:hover .track-title { text-decoration: underline; }
  li.playing { border-left: 3px solid #000; background: #f9f9f9; }
  .track-title { font-weight: bold; font-size: 0.9rem; line-height: 1.3; }
  .track-artist { font-size: 0.8rem; color: #444; margin-top: 0.2rem; }
  .track-meta { font-size: 0.7rem; color: #888; margin-top: 0.2rem; }

  li.hidden { display: none; }

  @media (max-width: 640px) {
    body { padding: 1rem; }
    .header { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
    .toolbar { gap: 0.5rem; }
    #search { max-width: none; }
    #player iframe { height: 120px; }
    ul { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="sticky-top">
  <div class="header">
    <div class="header-left">
      <h1>soobrosa likes</h1>
    </div>
    <div class="header-right">
      <div class="toolbar">
        <div class="tabs">
          <button class="active" data-filter="mix">Mixes <span class="count">(${mixes.length})</span></button>
          <button data-filter="song">Songs <span class="count">(${songs.length})</span></button>
        </div>
        <input type="text" id="search" placeholder="Filter...">
      </div>
      <div class="year-nav" id="year-nav">${yearNav(groups)}</div>
    </div>
  </div>
  <div id="player">
    <div class="player-actions">
      <button id="collect-current" type="button" disabled>Collect current mix</button>
      <span id="collect-status" aria-live="polite"></span>
    </div>
    <iframe id="sc-widget-a" src="" allow="autoplay"></iframe>
    <iframe id="sc-widget-b" src="" allow="autoplay"></iframe>
  </div>
</div>

<section id="collections" hidden>
  <h2>Collected mixes</h2>
  <div id="collection-groups"></div>
</section>

<div id="tracks">
  ${renderYearGroups(groups)}
</div>

<script src="https://w.soundcloud.com/player/api.js"></script>
<script>
  const player = document.getElementById('player');
  const stickyTop = document.querySelector('.sticky-top');
  const collectButton = document.getElementById('collect-current');
  const collectStatus = document.getElementById('collect-status');
  const collectionsSection = document.getElementById('collections');
  const collectionGroups = document.getElementById('collection-groups');
  const OPTS = { auto_play: true, color: '000000', show_artwork: true, show_comments: false, show_playcount: false, show_teaser: false, visual: false };
  const slots = [
    { iframe: document.getElementById('sc-widget-a'), widget: null, url: null, ready: false, loadToken: 0, readyCallbacks: [] },
    { iframe: document.getElementById('sc-widget-b'), widget: null, url: null, ready: false, loadToken: 0, readyCallbacks: [] }
  ];
  let activeSlot = null, currentLi = null, advancing = false, preloadTimer = null, advanceTimer = null;
  let collections = {}, collectionsReady = false;

  async function loadCollections() {
    try {
      const response = await fetch('/api/collections', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load collections');
      collections = await response.json();
      collectionsReady = true;
      renderCollections();
      updateCollectButton();
    } catch (e) {
      collectionsReady = false;
      collectButton.disabled = true;
      collectButton.textContent = 'Collections unavailable';
      collectStatus.textContent = 'Could not load saved mixes';
    }
  }

  function isCollected(li) {
    if (!li || li.dataset.type !== 'mix') return false;
    const items = collections[li.dataset.year] || [];
    return items.some(function(item) {
      return String(item.id) === li.dataset.id || item.url === li.querySelector('a').dataset.url;
    });
  }

  function updateCollectButton() {
    collectStatus.textContent = '';
    if (!collectionsReady) {
      collectButton.disabled = true;
      collectButton.textContent = 'Loading collections';
      return;
    }
    if (!currentLi || currentLi.dataset.type !== 'mix') {
      collectButton.disabled = true;
      collectButton.textContent = currentLi ? 'Mixes only' : 'Collect current mix';
      return;
    }
    const year = currentLi.dataset.year;
    const collected = isCollected(currentLi);
    collectButton.disabled = collected;
    collectButton.textContent = collected ? 'Collected in ' + year : 'Collect in ' + year;
  }

  function renderCollections() {
    collectionGroups.replaceChildren();
    const years = Object.keys(collections)
      .filter(function(year) { return Array.isArray(collections[year]) && collections[year].length; })
      .sort(function(a, b) { return Number(b) - Number(a); });
    collectionsSection.hidden = years.length === 0;

    years.forEach(function(year) {
      const group = document.createElement('div');
      group.className = 'collection-year';
      const heading = document.createElement('h3');
      heading.textContent = year + ' (' + collections[year].length + ')';
      const list = document.createElement('ul');

      collections[year].forEach(function(item) {
        const li = document.createElement('li');
        li.dataset.id = item.id;
        li.dataset.title = item.title;
        li.dataset.artist = item.artist;
        li.dataset.type = 'mix';
        li.dataset.year = year;
        const link = document.createElement('a');
        link.href = '#';
        link.dataset.url = item.url;
        link.addEventListener('click', function(event) {
          event.preventDefault();
          play(link);
        });
        const title = document.createElement('div');
        title.className = 'track-title';
        title.textContent = item.title;
        const artist = document.createElement('div');
        artist.className = 'track-artist';
        artist.textContent = item.artist;
        const meta = document.createElement('div');
        meta.className = 'track-meta';
        meta.textContent = item.meta;
        link.append(title, artist, meta);
        li.appendChild(link);
        list.appendChild(li);
      });

      group.append(heading, list);
      collectionGroups.appendChild(group);
    });
  }

  collectButton.addEventListener('click', async function() {
    if (!currentLi || currentLi.dataset.type !== 'mix' || isCollected(currentLi)) return;
    const year = currentLi.dataset.year;
    collectButton.disabled = true;
    collectButton.textContent = 'Saving...';
    collectStatus.textContent = '';
    try {
      const response = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: currentLi.dataset.id })
      });
      if (!response.ok) throw new Error('Could not save collection');
      collections = await response.json();
      renderCollections();
      updateCollectButton();
      collectStatus.textContent = 'Added to ' + year;
    } catch (e) {
      updateCollectButton();
      collectStatus.textContent = 'Could not save this mix';
    }
  });

  loadCollections();

  function updateTopHeight() {
    document.documentElement.style.setProperty('--top-h', stickyTop.offsetHeight + 'px');
  }
  updateTopHeight();
  if (window.ResizeObserver) new ResizeObserver(updateTopHeight).observe(stickyTop);
  window.addEventListener('resize', updateTopHeight);

  function getNextLink(li) {
    if (!li) return null;
    const type = li.dataset.type;
    const items = Array.from(document.querySelectorAll('#tracks li[data-type="' + type + '"]:not(.hidden)'));
    const idx = items.indexOf(li);
    if (idx >= 0 && idx < items.length - 1) {
      return items[idx + 1].querySelector('a');
    }
    return null;
  }

  function widgetUrl(url, autoPlay) {
    return 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) +
      '&auto_play=' + autoPlay +
      '&color=000000&show_artwork=true&show_comments=false&show_playcount=false&show_teaser=false&visual=false';
  }

  function finish(slot) {
    if (slot !== activeSlot || advancing) return;
    const nextLink = getNextLink(currentLi);
    if (!nextLink) return;

    advancing = true;
    const nextUrl = nextLink.dataset.url;
    const prepared = slots.find(function(candidate) {
      return candidate !== activeSlot && candidate.url === nextUrl;
    });

    if (prepared) {
      whenReady(prepared, function() {
        if (advancing && getNextLink(currentLi) === nextLink) {
          activate(prepared, nextLink.closest('li'), true);
        }
      });
    } else {
      play(nextLink, true);
    }
  }

  function clearAdvanceTimer() {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  }

  function scheduleAdvance(slot) {
    clearAdvanceTimer();
    const token = slot.loadToken;
    slot.widget.getDuration(function(dur) {
      slot.widget.getPosition(function(pos) {
        if (slot !== activeSlot || token !== slot.loadToken) return;
        const remaining = Math.max(0, (dur || 0) - (pos || 0));
        if (!remaining) return;
        advanceTimer = setTimeout(function() {
          advanceTimer = null;
          finish(slot);
        }, remaining + 500);
      });
    });
  }

  function markReady(slot, token) {
    if (token !== slot.loadToken) return;
    slot.ready = true;
    const callbacks = slot.readyCallbacks.splice(0);
    callbacks.forEach(function(callback) { callback(); });
  }

  function whenReady(slot, callback) {
    if (slot.ready) callback();
    else slot.readyCallbacks.push(callback);
  }

  function bindEvents(slot, token) {
    slot.widget.bind(SC.Widget.Events.READY, function() {
      markReady(slot, token);
    });
    slot.widget.bind(SC.Widget.Events.PLAY, function() {
      if (slot === activeSlot) {
        advancing = false;
        scheduleAdvance(slot);
      }
    });
    slot.widget.bind(SC.Widget.Events.PAUSE, function() {
      if (slot === activeSlot) clearAdvanceTimer();
    });
    slot.widget.bind(SC.Widget.Events.FINISH, function() {
      if (slot === activeSlot) clearAdvanceTimer();
      finish(slot);
    });
    slot.widget.bind(SC.Widget.Events.PLAY_PROGRESS, function(e) {
      if (slot === activeSlot && !advancing && e && e.relativePosition >= 0.999) finish(slot);
    });
  }

  function loadSlot(slot, url, autoPlay) {
    const token = ++slot.loadToken;
    slot.url = url;
    slot.ready = false;
    slot.readyCallbacks = [];

    if (!slot.widget) {
      slot.iframe.src = widgetUrl(url, autoPlay);
      slot.widget = SC.Widget(slot.iframe);
      bindEvents(slot, token);
      return;
    }

    slot.widget.load(url, Object.assign({}, OPTS, {
      auto_play: autoPlay,
      callback: function() { markReady(slot, token); }
    }));
  }

  function prepareNext() {
    if (!activeSlot || !currentLi) return;
    const nextLink = getNextLink(currentLi);
    if (!nextLink) return;

    const standby = slots.find(function(slot) { return slot !== activeSlot; });
    const nextUrl = nextLink.dataset.url;
    if (standby.url !== nextUrl) loadSlot(standby, nextUrl, false);
  }

  function schedulePrepareNext() {
    clearTimeout(preloadTimer);
    preloadTimer = setTimeout(prepareNext, 150);
  }

  function selectSlot(slot, li, isAdvance) {
    const previousSlot = activeSlot;
    clearAdvanceTimer();
    if (currentLi) currentLi.classList.remove('playing');
    li.classList.add('playing');
    currentLi = li;
    activeSlot = slot;
    advancing = isAdvance;
    updateCollectButton();
    slots.forEach(function(candidate) {
      candidate.iframe.classList.toggle('active', candidate === activeSlot);
    });
    player.classList.add('visible');
    if (previousSlot && previousSlot !== slot && previousSlot.widget) previousSlot.widget.pause();
  }

  function activate(slot, li, isAdvance) {
    selectSlot(slot, li, isAdvance);
    slot.widget.play();
    prepareNext();
    updateTopHeight();
  }

  function play(el, isAdvance) {
    const url = el.dataset.url;
    const li = el.closest('li');
    const prepared = slots.find(function(slot) {
      return slot.url === url && slot.ready;
    });

    if (prepared) {
      activate(prepared, li, Boolean(isAdvance));
      return;
    }

    const slot = isAdvance && activeSlot
      ? slots.find(function(candidate) { return candidate !== activeSlot; })
      : activeSlot || slots[0];
    selectSlot(slot, li, Boolean(isAdvance));
    loadSlot(slot, url, true);
    whenReady(slot, function() {
      if (activeSlot === slot && currentLi === li) slot.widget.play();
    });
    prepareNext();
    updateTopHeight();
  }

  function scrollToFirstVisibleYear() {
    const groups = document.querySelectorAll('#tracks .year-group');
    for (const g of groups) {
      if (g.style.display !== 'none') {
        g.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
    }
  }

  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      applyFilter();
      scrollToFirstVisibleYear();
    });
  });

  const search = document.getElementById('search');
  function applyFilter() {
    const q = search.value.toLowerCase();
    const showMix = document.querySelector('[data-filter="mix"]').classList.contains('active');
    const showSong = document.querySelector('[data-filter="song"]').classList.contains('active');
    document.querySelectorAll('#tracks li').forEach(li => {
      const type = li.dataset.type;
      const typeVisible = (type === 'mix' && showMix) || (type === 'song' && showSong);
      const title = (li.dataset.title || '').toLowerCase();
      const artist = (li.dataset.artist || '').toLowerCase();
      const searchMatch = !q || title.includes(q) || artist.includes(q);
      li.classList.toggle('hidden', !typeVisible || !searchMatch);
    });
    document.querySelectorAll('#tracks .year-group').forEach(g => {
      const visible = g.querySelectorAll('li:not(.hidden)').length;
      g.style.display = visible ? '' : 'none';
    });
    schedulePrepareNext();
  }
  search.addEventListener('input', applyFilter);
</script>
</body>
</html>`;
}
