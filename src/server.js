require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// ─── TMDb RELAY ───────────────────────────────────────────────────────────────
// Proxies TMDb so the API key lives server-side only
app.get('/api/tmdb/*', async (req, res) => {
  try {
    const tmdbPath = req.params[0];
    const query = new URLSearchParams(req.query);
    query.set('api_key', TMDB_KEY);
    query.set('language', 'en-US');
    const url = `https://api.themoviedb.org/3/${tmdbPath}?${query}`;
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TRAILER INFO ─────────────────────────────────────────────────────────────
// Finds the best trailer YouTube key for a given TMDb ID
app.get('/api/trailer/:type/:id', async (req, res) => {
  const { type, id } = req.params; // type = 'movie' | 'tv'

  // Try KinoCheck first (partners directly with studios)
  try {
    const kcType = type === 'tv' ? 'shows' : 'movies';
    const kcRes = await fetch(
      `https://api.kinocheck.com/${kcType}?tmdb_id=${id}&categories=Trailer`,
      { headers: { Accept: 'application/json' } }
    );
    if (kcRes.ok) {
      const kcData = await kcRes.json();
      const videos = kcData.trailer || kcData.videos || [];
      if (videos.length > 0 && videos[0].youtube_video_id) {
        return res.json({
          source: 'kinocheck',
          youtubeKey: videos[0].youtube_video_id,
          title: videos[0].title || 'Official Trailer',
        });
      }
    }
  } catch (_) {}

  // Fallback: TMDb videos endpoint
  try {
    const r = await fetch(
      `https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${TMDB_KEY}&language=en-US`
    );
    const data = await r.json();
    const videos = data.results || [];
    const pick = (t) =>
      videos.find((v) => v.site === 'YouTube' && v.type === t && v.official) ||
      videos.find((v) => v.site === 'YouTube' && v.type === t);
    const v = pick('Trailer') || pick('Teaser') || videos.find((v) => v.site === 'YouTube');
    if (v) return res.json({ source: 'tmdb', youtubeKey: v.key, title: v.name || 'Official Trailer' });
  } catch (_) {}

  res.status(404).json({ error: 'No trailer found' });
});

// ─── TRAILER PROXY ────────────────────────────────────────────────────────────
// Streams the YouTube video server-side with no Referer → no embed block
app.get('/api/proxy/trailer/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!ytdl.validateID(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchCMD/1.0)' },
      },
    });

    // Best format: 720p mp4 with audio, fallback to highest available
    let format;
    try {
      format = ytdl.chooseFormat(info.formats, {
        filter: (f) => f.container === 'mp4' && f.hasAudio && f.hasVideo && f.height <= 720,
        quality: 'highestvideo',
      });
    } catch (_) {
      format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
    }

    if (!format) return res.status(404).json({ error: 'No suitable format' });

    res.setHeader('Content-Type', format.mimeType || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (format.contentLength) res.setHeader('Content-Length', format.contentLength);

    ytdl(url, {
      format,
      requestOptions: {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchCMD/1.0)' },
      },
    })
      .on('error', (err) => {
        console.error('Stream error:', err.message);
        if (!res.headersSent) res.status(500).end();
      })
      .pipe(res);
  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => console.log(`Watch_CMD running → http://localhost:${PORT}`));
