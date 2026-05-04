require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const cors = require('cors');
const path = require('path');
const RealDebridClient = require('./realdebrid');
const TorrentProvider = require('./torrentProvider');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_KEY || '';
const RD_API_KEY = process.env.RD_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// ─── TMDb RELAY ───────────────────────────────────────────────────────────────
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
app.get('/api/trailer/:type/:id', async (req, res) => {
  const { type, id } = req.params;
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
        return res.json({ source: 'kinocheck', youtubeKey: videos[0].youtube_video_id, title: videos[0].title || 'Official Trailer' });
      }
    }
  } catch (_) {}
  try {
    const r = await fetch(`https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${TMDB_KEY}&language=en-US`);
    const data = await r.json();
    const videos = data.results || [];
    const pick = (t) => videos.find((v) => v.site === 'YouTube' && v.type === t && v.official) || videos.find((v) => v.site === 'YouTube' && v.type === t);
    const v = pick('Trailer') || pick('Teaser') || videos.find((v) => v.site === 'YouTube');
    if (v) return res.json({ source: 'tmdb', youtubeKey: v.key, title: v.name || 'Official Trailer' });
  } catch (_) {}
  res.status(404).json({ error: 'No trailer found' });
});

// ─── TRAILER PROXY ────────────────────────────────────────────────────────────
app.get('/api/proxy/trailer/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!ytdl.validateID(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchCMD/1.0)' } } });
    let format;
    try { format = ytdl.chooseFormat(info.formats, { filter: (f) => f.container === 'mp4' && f.hasAudio && f.hasVideo && f.height <= 720, quality: 'highestvideo' }); }
    catch (_) { format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' }); }
    if (!format) return res.status(404).json({ error: 'No suitable format' });
    res.setHeader('Content-Type', format.mimeType || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (format.contentLength) res.setHeader('Content-Length', format.contentLength);
    ytdl(url, { format, requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchCMD/1.0)' } } })
      .on('error', (err) => { console.error('Stream error:', err.message); if (!res.headersSent) res.status(500).end(); })
      .pipe(res);
  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── REAL-DEBRID STREAM ───────────────────────────────────────────────────────
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
const SOURCE_RANK = { 'BluRay': 4, 'WEB-DL': 3, 'WEBRip': 2, 'HDTV': 1, '': 0 };

// SSE endpoint — streams results to frontend as they resolve
app.get('/api/stream/:type/:tmdbId', async (req, res) => {
  const { type, tmdbId } = req.params;
  const season = req.query.s || null;
  const episode = req.query.e || null;
  const useSSE = req.query.sse === '1';

  if (!RD_API_KEY) return res.json({ streams: [], error: 'RD_API_KEY not configured' });

  // Set up SSE if requested
  if (useSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  try {
    // Get IMDB ID
    console.log(`[Stream] Lookup: ${type}/${tmdbId}`);
    const extRes = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`);
    const extData = await extRes.json();
    const imdbId = extData.imdb_id;
    if (!imdbId) {
      if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:'No IMDB ID found'})}\n\n`); return res.end(); }
      return res.json({ streams: [], error: 'No IMDB ID found' });
    }

    if (useSSE) res.write(`data: ${JSON.stringify({status:'Searching torrents...'})}\n\n`);

    // Search torrents
    const tp = new TorrentProvider();
    const searchId = (type === 'tv' && season && episode) ? `${imdbId}:${season}:${episode}` : imdbId;
    const torrents = await tp.search(type === 'tv' ? 'series' : 'movie', searchId);

    if (torrents.length === 0) {
      if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:'No torrents found'})}\n\n`); return res.end(); }
      return res.json({ streams: [], error: 'No torrents found' });
    }

    // Sort by quality
    torrents.sort((a, b) => {
      const qd = (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0);
      return qd !== 0 ? qd : (SOURCE_RANK[b.sourceType] || 0) - (SOURCE_RANK[a.sourceType] || 0);
    });

    const top = torrents.slice(0, 8);
    if (useSSE) res.write(`data: ${JSON.stringify({status:`Resolving ${top.length} torrents through RD...`})}\n\n`);
    console.log(`[Stream] Resolving ${top.length} torrents in parallel...`);

    // Resolve ALL in parallel
    const rd = new RealDebridClient(RD_API_KEY);
    const resolveOne = async (t) => {
      try {
        const result = await rd.resolveStream(t.infoHash, t.fileIdx, season ? +season : null, episode ? +episode : null);
        if (result && result.url) {
          return {
            url: result.url,
            quality: t.quality || 'Unknown',
            tags: [t.quality, t.sourceType, t.hdr, t.codec, t.audio, t.sizeStr].filter(Boolean).join(' · '),
            filename: result.filename || '',
            filesize: result.filesize || 0
          };
        }
      } catch (err) {
        console.error(`[Stream] Failed: ${err.message}`);
      }
      return null;
    };

    if (useSSE) {
      // Stream results as they come in
      const promises = top.map(t => resolveOne(t).then(stream => {
        if (stream) {
          res.write(`data: ${JSON.stringify({stream})}\n\n`);
          console.log(`[Stream] + ${stream.quality} → ${stream.filename}`);
        }
      }));
      await Promise.allSettled(promises);
      res.write(`data: ${JSON.stringify({done:true})}\n\n`);
      res.end();
    } else {
      // Non-SSE: resolve all in parallel, return at once
      const results = await Promise.allSettled(top.map(resolveOne));
      const streams = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
      console.log(`[Stream] Returning ${streams.length} streams`);
      res.json({ streams });
    }

  } catch (err) {
    console.error('[Stream] Error:', err.message);
    if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:err.message})}\n\n`); res.end(); }
    else res.json({ streams: [], error: err.message });
  }
});

// RD status check
app.get('/api/rd/status', (_, res) => res.json({ configured: !!RD_API_KEY }));

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', rd: !!RD_API_KEY }));

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  const rd = RD_API_KEY ? '✓ Active' : '✕ Not set';
  console.log(`Watch_CMD running → http://localhost:${PORT}  |  Real-Debrid: ${rd}`);
});
