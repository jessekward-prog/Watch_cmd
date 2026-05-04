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
const HOST = process.env.RAILWAY_PUBLIC_DOMAIN || null;

app.use(cors({ origin: '*', methods: 'GET,POST,OPTIONS', allowedHeaders: '*' }));
app.use(express.static(path.join(__dirname, '../public')));

// =============================================================================
//  WATCH_CMD — TMDb Browser + Trailer Proxy
// =============================================================================

// TMDb relay (API key stays server-side)
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

// Trailer info
app.get('/api/trailer/:type/:id', async (req, res) => {
  const { type, id } = req.params;

  // Try KinoCheck first
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

  // Fallback: TMDb
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

// Trailer proxy (bypasses YouTube embed blocks)
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

// =============================================================================
//  CHAOS_RD — Stremio Addon
// =============================================================================

const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
const SOURCE_RANK = { 'BluRay': 4, 'WEB-DL': 3, 'WEBRip': 2, 'HDTV': 1, '': 0 };

const baseUrl = HOST ? `https://${HOST}` : `http://localhost:${PORT}`;

const stremioManifest = {
  id: 'community.chaos.rd',
  version: '1.0.0',
  name: 'Chaos_RD',
  description: 'Stream movies and series through Real-Debrid. Cached torrents resolved to premium direct links.',
  logo: `${baseUrl}/logo.jpg`,
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

function formatStreamName(torrent) {
  const parts = [];
  if (torrent.quality && torrent.quality !== 'Unknown') parts.push(torrent.quality);
  if (torrent.sourceType) parts.push(torrent.sourceType);
  if (torrent.hdr) parts.push(torrent.hdr);
  return parts.length > 0 ? parts.join(' ') : 'Stream';
}

function formatStreamTitle(torrent) {
  const lines = [];
  const q = [];
  if (torrent.quality) q.push(torrent.quality);
  if (torrent.sourceType) q.push(torrent.sourceType);
  if (torrent.hdr) q.push(torrent.hdr);
  if (q.length > 0) lines.push(q.join(' | '));

  const t = [];
  if (torrent.codec) t.push(torrent.codec);
  if (torrent.audio) t.push(torrent.audio);
  if (torrent.sizeStr) t.push(torrent.sizeStr);
  if (t.length > 0) lines.push(t.join(' | '));

  lines.push('Chaos_RD');
  return lines.join('\n');
}

async function handleStream(type, id) {
  const startTime = Date.now();
  console.log(`\n[Chaos_RD] Stream: ${type} / ${id}`);

  if (!RD_API_KEY) {
    console.log('[Chaos_RD] No RD_API_KEY set');
    return { streams: [] };
  }

  let imdbId = id;
  let season = null;
  let episode = null;

  if (type === 'series') {
    const parts = id.split(':');
    imdbId = parts[0];
    season = parseInt(parts[1]) || null;
    episode = parseInt(parts[2]) || null;
    console.log(`[Chaos_RD] Series: ${imdbId} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
  }

  const rd = new RealDebridClient(RD_API_KEY);
  const torrentProvider = new TorrentProvider();

  try {
    const torrents = await torrentProvider.search(type, id);
    if (torrents.length === 0) {
      console.log('[Chaos_RD] No torrents found');
      return { streams: [] };
    }

    // Sort best quality first
    torrents.sort((a, b) => {
      const qDiff = (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0);
      if (qDiff !== 0) return qDiff;
      return (SOURCE_RANK[b.sourceType] || 0) - (SOURCE_RANK[a.sourceType] || 0);
    });

    // Resolve top 15 through RD
    const top = torrents.slice(0, 15);
    console.log(`[Chaos_RD] Resolving ${top.length} torrents...`);
    const streams = [];

    for (const torrent of top) {
      try {
        const result = await rd.resolveStream(torrent.infoHash, torrent.fileIdx, season, episode);
        if (result && result.url) {
          streams.push({
            name: `Chaos_RD ${formatStreamName(torrent)}`,
            title: formatStreamTitle(torrent),
            url: result.url,
            behaviorHints: {
              bingeGroup: `chaosrd-${torrent.quality || 'stream'}`,
              notWebReady: true,
              proxyHeaders: { request: { 'User-Agent': 'Mozilla/5.0' } }
            }
          });
          console.log(`[Chaos_RD] + ${torrent.quality} ${torrent.sourceType} → ${result.filename}`);
        }
      } catch (err) {
        console.error(`[Chaos_RD] Failed: ${torrent.infoHash.substring(0, 8)}: ${err.message}`);
      }
    }

    console.log(`[Chaos_RD] ${streams.length} streams (${Date.now() - startTime}ms)`);
    return { streams };
  } catch (err) {
    console.error(`[Chaos_RD] Error: ${err.message}`);
    return { streams: [] };
  }
}

// Stremio manifest
app.get('/stremio/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(stremioManifest);
});

// Stremio stream endpoints
app.get('/stremio/stream/:type/:id.json', async (req, res) => {
  try {
    const result = await handleStream(req.params.type, req.params.id);
    res.setHeader('Content-Type', 'application/json');
    res.json(result);
  } catch (err) {
    console.error('[Chaos_RD] Error:', err.message);
    res.json({ streams: [] });
  }
});

// =============================================================================
//  SHARED
// =============================================================================

app.get('/health', (_, res) => res.json({
  status: 'ok',
  watchCmd: true,
  chaosRd: !!RD_API_KEY,
  version: '1.0.0'
}));

// SPA fallback
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// Start
app.listen(PORT, '0.0.0.0', () => {
  const rdStatus = RD_API_KEY ? 'ACTIVE' : 'NOT SET — add RD_API_KEY env var';
  console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   Watch_CMD + Chaos_RD                            ║
  ║                                                   ║
  ║   Browse:   ${baseUrl}
  ║   Stremio:  ${baseUrl}/stremio/manifest.json
  ║                                                   ║
  ║   Real-Debrid: ${rdStatus}
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
  `);
});
