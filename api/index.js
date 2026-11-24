import { cacheGet, cacheSet, collectionsGet, fetchLikesFromSoundCloud, isMix, renderPage } from './_lib.js';

async function refreshCache() {
  const fresh = await fetchLikesFromSoundCloud();
  await cacheSet(fresh);
}

export default async function handler(req, res) {
  try {
    let { tracks, stale } = await cacheGet();

    if (!tracks) {
      tracks = await fetchLikesFromSoundCloud();
      await cacheSet(tracks);
    } else if (stale) {
      // Serve stale immediately; refresh in the background so the
      // visitor doesn't wait for the full SoundCloud refetch.
      refreshCache().catch(() => {});
    }

    const mixes = [];
    const songs = [];
    for (const t of tracks) {
      (isMix(t) ? mixes : songs).push(t);
    }

    // Rendered server-side so the section never appears after load (CLS).
    let collections = {};
    try {
      collections = await collectionsGet();
    } catch (e) {
      // Collections stay hidden if Redis is unavailable
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).send(renderPage(mixes, songs, collections));
  } catch (e) {
    res.status(500).send(`<pre>Error: ${e.message}</pre>`);
  }
}
