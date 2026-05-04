// Watch_CMD + Chaos_RD v2.0 — All-in-one server
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_KEY || '';
const RD_API_KEY = process.env.RD_API_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// =============================================================================
//  REAL-DEBRID CLIENT (inlined)
// =============================================================================
const RD_BASE_URL = 'https://api.real-debrid.com/rest/1.0';

class RealDebridClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = { 'Authorization': `Bearer ${apiKey}` };
  }

  async request(method, endpoint, body) {
    const options = { method, headers: { ...this.headers } };
    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(body).toString();
    }
    try {
      const r = await fetch(`${RD_BASE_URL}${endpoint}`, options);
      if (r.status === 204) return true;
      if (!r.ok) { console.error(`[RD] ${r.status} on ${endpoint}`); return null; }
      const text = await r.text();
      return text ? JSON.parse(text) : true;
    } catch (err) { console.error(`[RD] ${endpoint}: ${err.message}`); return null; }
  }

  async addMagnet(magnet) { return this.request('POST', '/torrents/addMagnet', { magnet }); }
  async getTorrentInfo(id) { return this.request('GET', `/torrents/info/${id}`); }
  async selectFiles(id, files) { return this.request('POST', `/torrents/selectFiles/${id}`, { files: files || 'all' }); }
  async unrestrictLink(link) { return this.request('POST', '/unrestrict/link', { link }); }
  async deleteTorrent(id) { return this.request('DELETE', `/torrents/delete/${id}`); }

  findEpisodeFile(files, season, episode) {
    if (!files || !files.length) return null;
    const vExts = /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i;
    const vFiles = files.filter(f => vExts.test(f.path));
    const patterns = [
      new RegExp(`S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`, 'i'),
      new RegExp(`${season}x${String(episode).padStart(2,'0')}`, 'i'),
    ];
    for (const p of patterns) { const m = vFiles.find(f => p.test(f.path)); if (m) return m; }
    return null;
  }

  findLargestVideoFile(files) {
    if (!files || !files.length) return null;
    const vExts = /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i;
    const vFiles = files.filter(f => vExts.test(f.path));
    return vFiles.length ? vFiles.reduce((a, b) => b.bytes > (a ? a.bytes : 0) ? b : a, null) : null;
  }

  async resolveStream(infoHash, fileIdx, season, episode) {
    let tid = null;
    try {
      const add = await this.addMagnet(`magnet:?xt=urn:btih:${infoHash}`);
      if (!add || !add.id) return null;
      tid = add.id;
      let info = await this.getTorrentInfo(tid);
      if (!info) { await this.cleanup(tid); return null; }

      if (info.status === 'waiting_files_selection') {
        let sel = 'all';
        if (season !== null && episode !== null && info.files) {
          const ef = this.findEpisodeFile(info.files, season, episode);
          if (ef) sel = String(ef.id);
        } else if (info.files) {
          const bf = this.findLargestVideoFile(info.files);
          if (bf) sel = String(bf.id);
        }
        await this.selectFiles(tid, sel);
        info = await this.getTorrentInfo(tid);
        if (!info) { await this.cleanup(tid); return null; }
      }

      if (info.status === 'downloaded' && info.links && info.links.length > 0) {
        const u = await this.unrestrictLink(info.links[0]);
        if (u && u.download) return { url: u.download, filename: u.filename || '', filesize: u.filesize || 0 };
      }

      await this.cleanup(tid);
      return null;
    } catch (err) { if (tid) await this.cleanup(tid); return null; }
  }

  async cleanup(id) { try { await this.deleteTorrent(id); } catch(e) {} }
}

// =============================================================================
//  TORRENT PROVIDER (inlined)
// =============================================================================
class TorrentProvider {
  constructor() {
    this.zileanUrl = 'https://zilean.elfhosted.com';
    this.torrentioUrl = 'https://torrentio.strem.fun';
  }

  async searchZilean(type, imdbId) {
    try {
      let cleanImdb = imdbId, season = null, episode = null;
      if (type === 'series') { const p = imdbId.split(':'); cleanImdb = p[0]; season = p[1]; episode = p[2]; }
      let url = `${this.zileanUrl}/dmm/filtered?ImdbId=${cleanImdb}`;
      if (season) url += `&Season=${season}`;
      if (episode) url += `&Episode=${episode}`;
      console.log(`[Torrent] Zilean: ${url}`);
      const r = await fetch(url, { timeout: 15000, headers: { 'Accept': 'application/json' } });
      if (!r.ok) { console.log(`[Torrent] Zilean ${r.status}`); return []; }
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) { console.log('[Torrent] Zilean: no results'); return []; }
      console.log(`[Torrent] Zilean: ${data.length} results`);
      return data.filter(i => i.infoHash).map(i => ({
        infoHash: i.infoHash.toLowerCase(), title: i.rawTitle || i.filename || 'Unknown',
        fileIdx: null, source: 'zilean', ...this.parse(i.rawTitle || i.filename || '')
      }));
    } catch (err) { console.error(`[Torrent] Zilean error: ${err.message}`); return []; }
  }

  async searchTorrentio(type, imdbId) {
    try {
      const url = `${this.torrentioUrl}/stream/${type}/${imdbId}.json`;
      console.log(`[Torrent] Torrentio: ${url}`);
      const r = await fetch(url, { timeout: 15000, headers: { 'User-Agent': 'Stremio', 'Accept': 'application/json' } });
      if (r.status === 403) { console.log('[Torrent] Torrentio 403'); return []; }
      if (!r.ok) return [];
      const data = await r.json();
      if (!data.streams || !data.streams.length) return [];
      console.log(`[Torrent] Torrentio: ${data.streams.length} streams`);
      return data.streams.filter(s => s.infoHash).map(s => ({
        infoHash: s.infoHash.toLowerCase(), title: s.title || 'Unknown',
        fileIdx: s.fileIdx !== undefined ? s.fileIdx : null, source: 'torrentio', ...this.parse(s.title || '')
      }));
    } catch (err) { console.error(`[Torrent] Torrentio error: ${err.message}`); return []; }
  }

  async search(type, imdbId) {
    console.log(`[Torrent] Searching ${type}: ${imdbId}`);
    const results = await Promise.allSettled([this.searchZilean(type, imdbId), this.searchTorrentio(type, imdbId)]);
    const all = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    const seen = new Set();
    const unique = all.filter(t => { if (seen.has(t.infoHash)) return false; seen.add(t.infoHash); return true; });
    console.log(`[Torrent] Total: ${unique.length} unique`);
    return unique;
  }

  parse(title) {
    const i = {};
    if (/2160p|4k|uhd/i.test(title)) i.quality='4K'; else if (/1080p/i.test(title)) i.quality='1080p';
    else if (/720p/i.test(title)) i.quality='720p'; else if (/480p/i.test(title)) i.quality='480p'; else i.quality='Unknown';
    if (/blu-?ray|bdremux/i.test(title)) i.sourceType='BluRay'; else if (/web-?dl/i.test(title)) i.sourceType='WEB-DL';
    else if (/web-?rip/i.test(title)) i.sourceType='WEBRip'; else if (/hdtv/i.test(title)) i.sourceType='HDTV'; else i.sourceType='';
    if (/hdr10\+/i.test(title)) i.hdr='HDR10+'; else if (/dolby.?vision|dv/i.test(title)) i.hdr='DV';
    else if (/hdr/i.test(title)) i.hdr='HDR'; else i.hdr='';
    if (/x265|h\.?265|hevc/i.test(title)) i.codec='HEVC'; else if (/x264|h\.?264/i.test(title)) i.codec='AVC';
    else if (/av1/i.test(title)) i.codec='AV1'; else i.codec='';
    if (/atmos/i.test(title)) i.audio='Atmos'; else if (/dts-?hd/i.test(title)) i.audio='DTS-HD';
    else if (/truehd/i.test(title)) i.audio='TrueHD'; else if (/dts/i.test(title)) i.audio='DTS';
    else if (/dd.?5\.1|ac3/i.test(title)) i.audio='DD5.1'; else if (/aac/i.test(title)) i.audio='AAC'; else i.audio='';
    const sm = title.match(/([\d.]+)\s*(GB|MB)/i); if (sm) i.sizeStr=`${sm[1]} ${sm[2].toUpperCase()}`;
    return i;
  }
}

// =============================================================================
//  WATCH_CMD — TMDb + Trailers
// =============================================================================
app.get('/api/tmdb/*', async (req, res) => {
  try {
    const q = new URLSearchParams(req.query); q.set('api_key', TMDB_KEY); q.set('language', 'en-US');
    const r = await fetch(`https://api.themoviedb.org/3/${req.params[0]}?${q}`);
    res.status(r.status).json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trailer/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  try {
    const kcType = type === 'tv' ? 'shows' : 'movies';
    const kcRes = await fetch(`https://api.kinocheck.com/${kcType}?tmdb_id=${id}&categories=Trailer`, { headers: { Accept: 'application/json' } });
    if (kcRes.ok) {
      const d = await kcRes.json(); const v = (d.trailer || d.videos || []);
      if (v.length > 0 && v[0].youtube_video_id) return res.json({ source: 'kinocheck', youtubeKey: v[0].youtube_video_id, title: v[0].title || 'Official Trailer' });
    }
  } catch (_) {}
  try {
    const r = await fetch(`https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${TMDB_KEY}&language=en-US`);
    const d = await r.json(); const vs = d.results || [];
    const pick = t => vs.find(v => v.site === 'YouTube' && v.type === t && v.official) || vs.find(v => v.site === 'YouTube' && v.type === t);
    const v = pick('Trailer') || pick('Teaser') || vs.find(v => v.site === 'YouTube');
    if (v) return res.json({ source: 'tmdb', youtubeKey: v.key, title: v.name || 'Official Trailer' });
  } catch (_) {}
  res.status(404).json({ error: 'No trailer found' });
});

app.get('/api/proxy/trailer/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!ytdl.validateID(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchCMD/1.0)' } } });
    let format;
    try { format = ytdl.chooseFormat(info.formats, { filter: f => f.container === 'mp4' && f.hasAudio && f.hasVideo && f.height <= 720, quality: 'highestvideo' }); }
    catch (_) { format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' }); }
    if (!format) return res.status(404).json({ error: 'No suitable format' });
    res.setHeader('Content-Type', format.mimeType || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (format.contentLength) res.setHeader('Content-Length', format.contentLength);
    ytdl(url, { format, requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WatchCMD/1.0)' } } })
      .on('error', err => { if (!res.headersSent) res.status(500).end(); })
      .pipe(res);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

// =============================================================================
//  REAL-DEBRID STREAM ENDPOINT
// =============================================================================
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
const SOURCE_RANK = { 'BluRay': 4, 'WEB-DL': 3, 'WEBRip': 2, 'HDTV': 1, '': 0 };

app.get('/api/stream/:type/:tmdbId', async (req, res) => {
  const { type, tmdbId } = req.params;
  const season = req.query.s || null, episode = req.query.e || null;
  const useSSE = req.query.sse === '1';

  if (!RD_API_KEY) return res.json({ streams: [], error: 'RD_API_KEY not configured' });

  if (useSSE) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders(); }

  try {
    console.log(`[Stream] Lookup: ${type}/${tmdbId}`);
    const extRes = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`);
    const extData = await extRes.json();
    const imdbId = extData.imdb_id;
    if (!imdbId) {
      if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:'No IMDB ID found'})}\n\n`); return res.end(); }
      return res.json({ streams: [], error: 'No IMDB ID found' });
    }

    if (useSSE) res.write(`data: ${JSON.stringify({status:'Searching torrents...'})}\n\n`);

    const tp = new TorrentProvider();
    const searchId = (type === 'tv' && season && episode) ? `${imdbId}:${season}:${episode}` : imdbId;
    const torrents = await tp.search(type === 'tv' ? 'series' : 'movie', searchId);

    if (!torrents.length) {
      if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:'No torrents found'})}\n\n`); return res.end(); }
      return res.json({ streams: [], error: 'No torrents found' });
    }

    torrents.sort((a, b) => {
      const qd = (QUALITY_RANK[b.quality]||0) - (QUALITY_RANK[a.quality]||0);
      return qd !== 0 ? qd : (SOURCE_RANK[b.sourceType]||0) - (SOURCE_RANK[a.sourceType]||0);
    });

    const top = torrents.slice(0, 8);
    if (useSSE) res.write(`data: ${JSON.stringify({status:`Resolving ${top.length} torrents through RD...`})}\n\n`);
    console.log(`[Stream] Resolving ${top.length} torrents...`);

    const rd = new RealDebridClient(RD_API_KEY);
    const resolve = async (t) => {
      try {
        const result = await rd.resolveStream(t.infoHash, t.fileIdx, season ? +season : null, episode ? +episode : null);
        if (result && result.url) return {
          url: result.url, quality: t.quality || 'Unknown',
          tags: [t.quality, t.sourceType, t.hdr, t.codec, t.audio, t.sizeStr].filter(Boolean).join(' · '),
          filename: result.filename || '', filesize: result.filesize || 0
        };
      } catch (e) {} return null;
    };

    if (useSSE) {
      const promises = top.map(t => resolve(t).then(s => { if (s) { res.write(`data: ${JSON.stringify({stream:s})}\n\n`); console.log(`[Stream] + ${s.quality} → ${s.filename}`); } }));
      await Promise.allSettled(promises);
      res.write(`data: ${JSON.stringify({done:true})}\n\n`); res.end();
    } else {
      const results = await Promise.allSettled(top.map(resolve));
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

app.get('/api/rd/status', (_, res) => res.json({ configured: !!RD_API_KEY }));
app.get('/health', (_, res) => res.json({ status: 'ok', rd: !!RD_API_KEY }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  const rd = RD_API_KEY ? '✓ Active' : '✕ Not set';
  console.log(`Watch_CMD v2.0 → http://localhost:${PORT}  |  Real-Debrid: ${rd}`);
});
