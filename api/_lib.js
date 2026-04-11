const USERNAME = 'soobrosa';
const MIX_KEYWORDS = /\b(mixtape|podcast|dj set|session|live at|live @|@ |b2b|boiler room|furnace|radio show|takeover|essential mix|rinse|nts)\b/i;
const MIX_KEYWORDS_NO_PARENS = /\b(mix|dj )\b/i;
const MIX_DURATION_MS = 30 * 60 * 1000;
const CACHE_KEY = 'sc-likes-tracks';
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
  return `<li data-title="${esc(t.title)}" data-artist="${esc(t.user.username)}" data-type="${type}">
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
  #player iframe { width: 100%; height: 125px; border: none; }

  .year-group { margin-bottom: 2rem; }
  .year-header { font-family: 'Oswald', sans-serif; font-size: 1.2rem; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 2px solid #000; padding-bottom: 0.2rem; margin-bottom: 0.75rem; position: sticky; top: 0; background: #fff; z-index: 10; padding-top: 0.3rem; }
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
          <button class="active" data-filter="song">Songs <span class="count">(${songs.length})</span></button>
        </div>
        <input type="text" id="search" placeholder="Filter...">
      </div>
      <div class="year-nav" id="year-nav">${yearNav(groups)}</div>
    </div>
  </div>
  <div id="player"><iframe id="sc-widget" src="" allow="autoplay"></iframe></div>
</div>

<div id="tracks">
  ${renderYearGroups(groups)}
</div>

<script src="https://w.soundcloud.com/player/api.js"></script>
<script>
  let widget, currentLi;

  function play(el) {
    const url = el.dataset.url;
    const li = el.closest('li');
    const iframe = document.getElementById('sc-widget');

    if (currentLi) currentLi.classList.remove('playing');
    li.classList.add('playing');
    currentLi = li;

    const embedUrl = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) + '&auto_play=true&color=000000&show_artwork=true&show_comments=false&show_playcount=false&show_teaser=false&visual=false';
    iframe.src = embedUrl;
    document.getElementById('player').classList.add('visible');

    widget = SC.Widget(iframe);
    widget.bind(SC.Widget.Events.READY, function() {
      widget.bind(SC.Widget.Events.FINISH, function() {
        const items = Array.from(document.querySelectorAll('#tracks li:not(.hidden)'));
        const idx = items.indexOf(currentLi);
        if (idx >= 0 && idx < items.length - 1) {
          const nextLink = items[idx + 1].querySelector('a');
          if (nextLink) play(nextLink);
        }
      });
    });
  }

  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      applyFilter();
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
  }
  search.addEventListener('input', applyFilter);
</script>
</body>
</html>`;
}
