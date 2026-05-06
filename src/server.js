// Watch_CMD + Chaos_RD v2.1 — YTS API for torrent search
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const { pool, init: initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_KEY || '';
const RD_API_KEY = process.env.RD_API_KEY || '';

app.use(cors());
app.use(express.json());
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

  // Returns { hash: { rd: [...] } } — only hashes with non-empty rd arrays are cached
  async checkInstantAvailability(hashes) {
    if (!hashes.length) return {};
    try {
      const data = await this.request('GET', `/torrents/instantAvailability/${hashes.slice(0, 40).join('/')}`);
      return data || {};
    } catch { return {}; }
  }

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
    if (!vFiles.length) return null;
    // Prefer MP4 (browser-native) over MKV; within same container pick largest
    const mp4s = vFiles.filter(f => /\.mp4$/i.test(f.path));
    const pool = mp4s.length ? mp4s : vFiles;
    return pool.reduce((a, b) => b.bytes > (a ? a.bytes : 0) ? b : a, null);
  }

  async resolveStream(infoHash, fileIdx, season, episode) {
    let tid = null;
    const TRACKERS = [
      'udp://open.demonii.com:1337',
      'udp://tracker.openbittorrent.com:80',
      'udp://tracker.opentrackr.org:1337',
      'udp://tracker.coppersurfer.tk:6969',
      'udp://glotorrents.pw:6969',
    ].map(t => `&tr=${encodeURIComponent(t)}`).join('');
    try {
      const magnet = `magnet:?xt=urn:btih:${infoHash}${TRACKERS}`;
      const add = await this.addMagnet(magnet);
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
        // Give RD a moment to process the cached torrent
        await new Promise(r => setTimeout(r, 1500));
        info = await this.getTorrentInfo(tid);
        if (!info) { await this.cleanup(tid); return null; }
      }

      if (info.status === 'downloaded' && info.links && info.links.length > 0) {
        const u = await this.unrestrictLink(info.links[0]);
        if (u && u.download) return { url: u.download, filename: u.filename || '', filesize: u.filesize || 0 };
      }

      console.log(`[RD] Hash ${infoHash.slice(0,8)} status: ${info.status} — skipping`);
      await this.cleanup(tid);
      return null;
    } catch (err) { if (tid) await this.cleanup(tid); return null; }
  }

  async cleanup(id) { try { await this.deleteTorrent(id); } catch(e) {} }
}

// =============================================================================
//  TORRENT PROVIDER — YTS + Apibay (TPB) + EZTV + Torrentio fallback
// =============================================================================
class TorrentProvider {
  constructor() {
    this.ytsUrl       = 'https://yts.mx/api/v2';
    this.torrentioUrl = 'https://torrentio.strem.fun';
    this.eztvUrl      = 'https://eztv.re/api';
  }

  // YTS — try IMDB ID first, fall back to title search if empty
  async searchYTS(imdbId, title, year) {
    const attempt = async (query) => {
      try {
        const url = `${this.ytsUrl}/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20`;
        console.log(`[Torrent] YTS: ${url}`);
        const r = await fetch(url, { timeout: 8000, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) { console.log(`[Torrent] YTS ${r.status}`); return []; }
        const data = await r.json();
        if (!data.data?.movies?.length) return [];
        const out = [];
        for (const movie of data.data.movies) {
          if (!movie.torrents) continue;
          for (const t of movie.torrents) {
            if (!t.hash) continue;
            out.push({
              infoHash: t.hash.toLowerCase(),
              title: `${movie.title_long} [${t.quality}] [${t.type}]`,
              fileIdx: null, source: 'yts',
              quality: t.quality === '2160p' ? '4K' : t.quality || 'Unknown',
              sourceType: t.type === 'bluray' ? 'BluRay' : t.type === 'web' ? 'WEB-DL' : '',
              hdr: '', codec: '', audio: '', sizeStr: t.size || ''
            });
          }
        }
        return out;
      } catch (err) { console.error(`[Torrent] YTS error: ${err.message}`); return []; }
    };

    const cleanImdb = imdbId.split(':')[0];
    let results = await attempt(cleanImdb);
    if (!results.length && title) {
      console.log('[Torrent] YTS IMDB miss — retrying with title');
      results = await attempt(year ? `${title} ${year}` : title);
    }
    console.log(`[Torrent] YTS: ${results.length} torrents`);
    return results;
  }

  // Apibay (TPB official API) — IMDB ID search, works for movies and TV
  async searchApibay(imdbId, type) {
    try {
      const cleanId = imdbId.split(':')[0];
      const cat = type === 'series' ? '205' : '207'; // 205=TV shows, 207=HD Movies
      const url = `https://apibay.org/q.php?q=imdb:${cleanId}&cat=${cat}`;
      console.log(`[Torrent] Apibay: ${url}`);
      const r = await fetch(url, { timeout: 8000, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { console.log(`[Torrent] Apibay ${r.status}`); return []; }
      const data = await r.json();
      if (!data?.length || data[0]?.name === 'No results returned') { console.log('[Torrent] Apibay: no results'); return []; }
      const results = data
        .filter(t => t.info_hash && t.info_hash !== '0000000000000000000000000000000000000000')
        .map(t => {
          const sb = parseInt(t.size, 10) || 0;
          const sizeStr = sb > 1e9 ? `${(sb/1e9).toFixed(1)} GB` : sb > 1e6 ? `${(sb/1e6).toFixed(0)} MB` : '';
          return { infoHash: t.info_hash.toLowerCase(), title: t.name || 'Unknown', fileIdx: null, source: 'apibay', sizeStr, ...this.parse(t.name || '') };
        });
      console.log(`[Torrent] Apibay: ${results.length} torrents`);
      return results;
    } catch (err) { console.error(`[Torrent] Apibay error: ${err.message}`); return []; }
  }

  // EZTV — TV public API
  async searchEZTV(searchId) {
    try {
      const [rawId, season, episode] = searchId.split(':');
      const numericId = rawId.replace(/^tt/i, '');
      const url = `${this.eztvUrl}/get-torrents?imdb_id=${numericId}&limit=100`;
      console.log(`[Torrent] EZTV: ${url}`);
      const r = await fetch(url, { timeout: 8000, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { console.log(`[Torrent] EZTV ${r.status}`); return []; }
      const data = await r.json();
      if (!data.torrents?.length) { console.log('[Torrent] EZTV: no results'); return []; }
      let torrents = data.torrents;
      if (season && episode) {
        const s = parseInt(season, 10), e = parseInt(episode, 10);
        const specific = torrents.filter(t => parseInt(t.season, 10) === s && parseInt(t.episode, 10) === e);
        if (specific.length) torrents = specific;
      }
      const results = torrents.map(t => {
        const hash = (t.hash || '').toLowerCase();
        if (!hash) return null;
        const sb = parseInt(t.size_bytes, 10) || 0;
        const sizeStr = sb > 1e9 ? `${(sb/1e9).toFixed(1)} GB` : sb > 1e6 ? `${(sb/1e6).toFixed(0)} MB` : '';
        return { infoHash: hash, title: t.filename || 'Unknown', fileIdx: null, source: 'eztv', sizeStr, ...this.parse(t.filename || '') };
      }).filter(Boolean);
      console.log(`[Torrent] EZTV: ${results.length} torrents`);
      return results;
    } catch (err) { console.error(`[Torrent] EZTV: ${err.message}`); return []; }
  }

  // Torrentio — usually blocked on cloud IPs but try anyway
  async searchTorrentio(type, imdbId) {
    try {
      const url = `${this.torrentioUrl}/stream/${type}/${imdbId}.json`;
      console.log(`[Torrent] Torrentio: ${url}`);
      const r = await fetch(url, { timeout: 4000, headers: { 'User-Agent': 'Stremio', 'Accept': 'application/json' } });
      if (r.status === 403) { console.log('[Torrent] Torrentio 403 (blocked)'); return []; }
      if (!r.ok) return [];
      const data = await r.json();
      if (!data.streams?.length) return [];
      console.log(`[Torrent] Torrentio: ${data.streams.length} streams`);
      return data.streams.filter(s => s.infoHash).map(s => ({
        infoHash: s.infoHash.toLowerCase(), title: s.title || 'Unknown',
        fileIdx: s.fileIdx !== undefined ? s.fileIdx : null, source: 'torrentio', ...this.parse(s.title || '')
      }));
    } catch (err) { console.error(`[Torrent] Torrentio error: ${err.message}`); return []; }
  }

  async search(type, imdbId, title = '', year = '') {
    console.log(`[Torrent] Searching ${type}: ${imdbId} "${title}" ${year}`);
    const searches = [];
    if (type === 'movie') searches.push(this.searchYTS(imdbId, title, year));
    if (type === 'series') searches.push(this.searchEZTV(imdbId));

    const results = await Promise.allSettled(searches);
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

app.get('/api/trailer', async (req, res) => {
  const { tmdb_id: id, type = 'movie' } = req.query;
  if (!id) return res.status(400).json({ error: 'tmdb_id required' });

  const makeUrls = (key, title) => ({
    youtubeKey: key,
    embedUrl: `https://www.youtube.com/embed/${key}?autoplay=1&rel=0&modestbranding=1`,
    watchUrl: `https://www.youtube.com/watch?v=${key}`,
    title: title || 'Official Trailer',
  });

  try {
    const kcType = type === 'tv' ? 'shows' : 'movies';
    const kcRes = await fetch(`https://api.kinocheck.com/${kcType}?tmdb_id=${id}&categories=Trailer`, { headers: { Accept: 'application/json' } });
    if (kcRes.ok) {
      const d = await kcRes.json(); const v = (d.trailer || d.videos || []);
      if (v.length > 0 && v[0].youtube_video_id)
        return res.json(makeUrls(v[0].youtube_video_id, v[0].title));
    }
  } catch (_) {}
  try {
    const r = await fetch(`https://api.themoviedb.org/3/${type}/${id}/videos?api_key=${TMDB_KEY}&language=en-US`);
    const d = await r.json(); const vs = d.results || [];
    const pick = t => vs.find(v => v.site === 'YouTube' && v.type === t && v.official) || vs.find(v => v.site === 'YouTube' && v.type === t);
    const v = pick('Trailer') || pick('Teaser') || vs.find(v => v.site === 'YouTube');
    if (v) return res.json(makeUrls(v.key, v.name));
  } catch (_) {}
  res.status(404).json({ error: 'No trailer found' });
});

app.get('/api/proxy/trailer/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!ytdl.validateID(videoId)) return res.status(400).json({ error: 'Invalid video ID' });
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const reqOpts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
    const info = await ytdl.getInfo(url, { requestOptions: reqOpts });

    // Prefer combined MP4 with audio at ≤720p, then any combined stream
    let format =
      ytdl.chooseFormat(info.formats, { filter: f => f.container === 'mp4' && f.hasAudio && f.hasVideo && f.height <= 720, quality: 'highestvideo' }).catch?.(() => null) ??
      (() => {
        try { return ytdl.chooseFormat(info.formats, { filter: f => f.hasAudio && f.hasVideo, quality: 'highestvideo' }); } catch { return null; }
      })() ??
      (() => {
        try { return ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' }); } catch { return null; }
      })();

    // chooseFormat throws (doesn't return null) — normalise with try/catch chain
    if (!format) {
      try { format = ytdl.chooseFormat(info.formats, { filter: f => f.hasAudio && f.hasVideo, quality: 'highestvideo' }); } catch (_) {}
    }
    if (!format) {
      try { format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' }); } catch (_) {}
    }
    if (!format) return res.status(404).json({ error: 'No suitable format found' });

    const contentLength = format.contentLength ? parseInt(format.contentLength, 10) : null;
    const range = req.headers.range;

    if (range && contentLength) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : contentLength - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${contentLength}`);
      res.setHeader('Content-Length', end - start + 1);
    } else if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    res.setHeader('Content-Type', format.mimeType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    ytdl(url, { format, requestOptions: reqOpts })
      .on('error', () => { if (!res.headersSent) res.status(500).end(); })
      .pipe(res);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

// =============================================================================
//  REAL-DEBRID STREAM ENDPOINT
// =============================================================================
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
const SOURCE_RANK  = { 'BluRay': 4, 'WEB-DL': 3, 'WEBRip': 2, 'HDTV': 1, '': 0 };
// Browser codec compatibility: AVC (H.264) plays natively everywhere; HEVC needs HW decoder
const CODEC_RANK   = { 'AVC': 3, '': 2, 'AV1': 2, 'HEVC': 1 };
// Browser audio compatibility: AAC/no-tag are safe; AC3/DTS require plugins
const AUDIO_RANK   = { 'AAC': 3, '': 2, 'DD5.1': 1, 'DTS': 0, 'DTS-HD': 0, 'TrueHD': 0, 'Atmos': 0 };

app.get('/api/stream/:type/:tmdbId', async (req, res) => {
  const { type, tmdbId } = req.params;
  const season = req.query.s || null, episode = req.query.e || null;
  const useSSE = req.query.sse === '1';

  if (!RD_API_KEY) return res.json({ streams: [], error: 'RD_API_KEY not configured' });

  if (useSSE) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders(); }

  try {
    console.log(`[Stream] Lookup: ${type}/${tmdbId}`);
    const [extRes, detRes] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`),
      fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_KEY}`),
    ]);
    const extData = await extRes.json();
    const detData = await detRes.json();
    const imdbId = extData.imdb_id;
    const title = detData.title || detData.name || '';
    const year = (detData.release_date || detData.first_air_date || '').slice(0, 4);
    if (!imdbId) {
      if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:'No IMDB ID found'})}\n\n`); return res.end(); }
      return res.json({ streams: [], error: 'No IMDB ID found' });
    }

    if (useSSE) res.write(`data: ${JSON.stringify({status:'Searching torrents...'})}\n\n`);

    const tp = new TorrentProvider();
    const searchId = (type === 'tv' && season && episode) ? `${imdbId}:${season}:${episode}` : imdbId;
    const torrents = await tp.search(type === 'tv' ? 'series' : 'movie', searchId, title, year);

    if (!torrents.length) {
      if (useSSE) { res.write(`data: ${JSON.stringify({done:true,error:'No torrents found'})}\n\n`); return res.end(); }
      return res.json({ streams: [], error: 'No torrents found' });
    }

    torrents.sort((a, b) => {
      const qd = (QUALITY_RANK[b.quality]||0)    - (QUALITY_RANK[a.quality]||0);    if (qd) return qd;
      const sd = (SOURCE_RANK[b.sourceType]||0)  - (SOURCE_RANK[a.sourceType]||0);  if (sd) return sd;
      const cd = (CODEC_RANK[b.codec]||2)        - (CODEC_RANK[a.codec]||2);        if (cd) return cd;
      return     (AUDIO_RANK[b.audio]||2)        - (AUDIO_RANK[a.audio]||2);
    });

    const rd = new RealDebridClient(RD_API_KEY);

    // Check which torrents are already cached in RD (instant availability)
    if (useSSE) res.write(`data: ${JSON.stringify({status:'Checking RD cache...'})}\n\n`);
    const top20 = torrents.slice(0, 20);
    const avail = await rd.checkInstantAvailability(top20.map(t => t.infoHash));
    const cached = top20.filter(t => {
      const a = avail[t.infoHash];
      return a && a.rd && a.rd.length > 0;
    });
    console.log(`[Stream] RD cache: ${cached.length}/${top20.length} torrents available`);

    // Use cached torrents; if none, fall back to top 5 (they may still resolve if previously added)
    const top = cached.length > 0 ? cached.slice(0, 10) : top20.slice(0, 5);
    if (cached.length === 0 && useSSE) res.write(`data: ${JSON.stringify({status:'No instant cache — trying top results anyway...'})}\n\n`);
    else if (useSSE) res.write(`data: ${JSON.stringify({status:`Found ${cached.length} cached streams, resolving...`})}\n\n`);
    console.log(`[Stream] Resolving ${top.length} torrents...`);
    const MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
    const resolve = async (t) => {
      try {
        const result = await rd.resolveStream(t.infoHash, t.fileIdx, season ? +season : null, episode ? +episode : null);
        if (result && result.url) {
          if (result.filesize && result.filesize > MAX_BYTES) {
            console.log(`[Stream] Skipped ${result.filename} — ${(result.filesize/1e9).toFixed(1)} GB > 8 GB`);
            return null;
          }
          return {
            url: result.url, quality: t.quality || 'Unknown',
            tags: [t.quality, t.sourceType, t.hdr, t.codec, t.audio, t.sizeStr].filter(Boolean).join(' · '),
            filename: result.filename || '', filesize: result.filesize || 0
          };
        }
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

// Transcode audio to AAC on-the-fly via ffmpeg (fixes AC3/DTS in browser)
app.get('/api/transcode', (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://')) return res.status(400).end();

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const ff = spawn('ffmpeg', [
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-probesize', '10M',
    '-loglevel', 'error',
    '-i', url,
    '-c:v', 'copy',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stdout.pipe(res);
  ff.stderr.on('data', d => process.stdout.write('[ffmpeg] ' + d.toString().split('\n')[0] + '\n'));
  ff.on('error', err => { console.error('[ffmpeg]', err.message); if (!res.headersSent) res.status(500).end(); });

  const kill = () => ff.kill('SIGKILL');
  req.on('close', kill);
  res.on('close', kill);
});

// =============================================================================
//  WATCH HISTORY
// =============================================================================
const dbErr = (res, err) => { console.error('[DB]', err.message); res.status(500).json({ error: err.message }); };

app.get('/api/history', async (_, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM watch_history ORDER BY updated_at DESC'); res.json(rows); }
  catch (err) { dbErr(res, err); }
});

app.post('/api/history', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  const { tmdb_id, media_type, title, poster_path, progress, position_sec, duration_sec, watched, season = -1, episode = -1 } = req.body;
  try {
    await pool.query(`
      INSERT INTO watch_history (tmdb_id,media_type,title,poster_path,progress,position_sec,duration_sec,watched,season,episode,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (tmdb_id,media_type,season,episode) DO UPDATE SET
        progress=EXCLUDED.progress, position_sec=EXCLUDED.position_sec,
        duration_sec=EXCLUDED.duration_sec, watched=EXCLUDED.watched,
        title=EXCLUDED.title, poster_path=EXCLUDED.poster_path, updated_at=NOW()
    `, [tmdb_id, media_type, title, poster_path, progress, position_sec, duration_sec, watched, season, episode]);
    res.json({ ok: true });
  } catch (err) { dbErr(res, err); }
});

app.delete('/api/history/:tmdbId', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try { await pool.query('DELETE FROM watch_history WHERE tmdb_id=$1', [req.params.tmdbId]); res.json({ ok: true }); }
  catch (err) { dbErr(res, err); }
});

app.get('/api/rd/status', (_, res) => res.json({ configured: !!RD_API_KEY }));
app.get('/health', (_, res) => res.json({ status: 'ok', rd: !!RD_API_KEY }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

initDB().catch(err => console.error('[DB] init failed:', err.message));

app.listen(PORT, () => {
  const rd = RD_API_KEY ? '✓ Active' : '✕ Not set';
  console.log(`Watch_CMD v2.0 → http://localhost:${PORT}  |  Real-Debrid: ${rd}`);
});
