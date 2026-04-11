# sc-likes

A Vercel serverless app that displays your SoundCloud liked tracks, split into **Mixes** and **Songs**.

Live at [sc-likes.vercel.app](https://sc-likes.vercel.app)

## How it works

- Single page with all liked tracks grouped by year, displayed in a two-column grid
- **Mixes** and **Songs** toggle buttons (non-exclusive) to filter by type, plus a text search
- Year navigation bar for quick jumping
- Clicking a track plays it inline via the SoundCloud embedded player; auto-advances to the next visible track when finished
- Shared logic lives in `api/_lib.js`

## Track classification

- **>= 30 min**: always a mix
- **< 10 min**: always a song
- **10-30 min**: classified by keywords (`mix`, `dj`, `mixtape`, `podcast`, `dj set`, `boiler room`, `nts`, `b2b`, etc.)
  - `mix` and `dj` are ignored when they appear inside parentheses (e.g. "Track Name (DJ Koze Remix)" is a song)

## Caching

Uses [Upstash Redis](https://upstash.com) (REST API, zero npm dependencies) for persistent caching with inline stale-while-revalidate:

- Cached data includes a timestamp; if fresh (<1 hour), served immediately
- If stale, SoundCloud is fetched inline and cache is updated; stale data is served if refresh fails
- Only the fields needed for rendering are stored (~200-300 bytes per track)
- `api/refresh.js` is available as a manual endpoint to force a cache refresh
- Vercel CDN cache (`s-maxage=3600, stale-while-revalidate`) sits in front as an additional layer

The app works without Redis -- it just fetches from SoundCloud on every request.

## Setup

1. Create a free Redis database at [console.upstash.com](https://console.upstash.com)
2. Add environment variables via the Vercel CLI:
   ```bash
   npx vercel env add UPSTASH_REDIS_REST_URL production
   npx vercel env add UPSTASH_REDIS_REST_TOKEN production
   ```
3. Deploy:
   ```bash
   npx vercel --prod
   ```

To verify Redis is working, visit `/api/refresh` -- it returns `{"updated": true, "tracks": N}` on success.

## Project structure

```
api/
  _lib.js      Shared: SoundCloud fetching, classification, rendering, cache helpers
  index.js     Main handler: serve from cache, stale-while-revalidate, SoundCloud fallback
  refresh.js   Manual endpoint: force refresh cache from SoundCloud
vercel.json    Rewrites
package.json   Project metadata (no dependencies)
```
