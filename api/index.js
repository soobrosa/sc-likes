import { cacheGet, cacheSet, fetchLikesFromSoundCloud, isMix, renderPage } from './_lib.js';

export default async function handler(req, res) {
  try {
    let { tracks, stale } = await cacheGet();

    if (!tracks) {
      tracks = await fetchLikesFromSoundCloud();
      await cacheSet(tracks);
    } else if (stale) {
      try {
        const fresh = await fetchLikesFromSoundCloud();
        await cacheSet(fresh);
        tracks = fresh;
      } catch (e) {
        // serve stale cache if refresh fails
      }
    }

    const mixes = [];
    const songs = [];
    for (const t of tracks) {
      (isMix(t) ? mixes : songs).push(t);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).send(renderPage(mixes, songs));
  } catch (e) {
    res.status(500).send(`<pre>Error: ${e.message}</pre>`);
  }
}
