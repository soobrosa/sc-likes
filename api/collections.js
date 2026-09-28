import {
  cacheGet,
  cacheSet,
  collectionAdd,
  collectionsGet,
  fetchLikesFromSoundCloud,
  isMix
} from './_lib.js';

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      res.status(200).json(await collectionsGet());
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      sendError(res, 405, 'Method not allowed');
      return;
    }

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const trackId = String(body?.trackId || '');
    if (!trackId) {
      sendError(res, 400, 'trackId is required');
      return;
    }

    let { tracks } = await cacheGet();
    if (!tracks) {
      tracks = await fetchLikesFromSoundCloud();
      await cacheSet(tracks);
    }

    const track = tracks.find(item => String(item.id) === trackId);
    if (!track) {
      sendError(res, 404, 'Track not found in SoundCloud likes');
      return;
    }
    if (!isMix(track)) {
      sendError(res, 400, 'Only mixes can be collected');
      return;
    }

    res.status(200).json(await collectionAdd(track));
  } catch (e) {
    sendError(res, 500, e.message);
  }
}
