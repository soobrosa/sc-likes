import { cacheGet, cacheSet, fetchLikesFromSoundCloud } from './_lib.js';

export default async function handler(req, res) {
  try {
    const fresh = await fetchLikesFromSoundCloud();
    const { tracks: cached } = await cacheGet();

    const freshIds = fresh.map(t => t.id).join(',');
    const cachedIds = cached ? cached.map(t => t.id).join(',') : '';

    if (freshIds !== cachedIds) {
      await cacheSet(fresh);
      res.status(200).json({ updated: true, tracks: fresh.length });
    } else {
      await cacheSet(fresh); // refresh timestamp
      res.status(200).json({ updated: false, tracks: fresh.length });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
