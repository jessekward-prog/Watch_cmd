const fetch = require('node-fetch');

class TorrentProvider {
    constructor(config = {}) {
        this.jackettUrl = config.jackettUrl || null;
        this.jackettApiKey = config.jackettApiKey || null;
        this.zileanUrl = 'https://zilean.elfhosted.com';
        this.torrentioUrl = 'https://torrentio.strem.fun';
    }

    // Zilean - PRIMARY source (DMM hashes, cloud-friendly, won't block datacenter IPs)
    async searchZilean(type, imdbId) {
        try {
            let cleanImdb = imdbId;
            let season = null;
            let episode = null;

            if (type === 'series') {
                const parts = imdbId.split(':');
                cleanImdb = parts[0];
                season = parts[1] || null;
                episode = parts[2] || null;
            }

            let url = `${this.zileanUrl}/dmm/filtered?ImdbId=${cleanImdb}`;
            if (season) url += `&Season=${season}`;
            if (episode) url += `&Episode=${episode}`;

            console.log(`[Torrent] Zilean: ${url}`);

            const response = await fetch(url, {
                timeout: 15000,
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                console.log(`[Torrent] Zilean returned ${response.status}`);
                return [];
            }

            const data = await response.json();

            if (!data || !Array.isArray(data) || data.length === 0) {
                console.log('[Torrent] Zilean returned no results');
                return [];
            }

            console.log(`[Torrent] Zilean returned ${data.length} results`);

            return data
                .filter(item => item.infoHash)
                .map(item => ({
                    infoHash: item.infoHash.toLowerCase(),
                    title: item.rawTitle || item.filename || 'Unknown',
                    fileIdx: null,
                    name: item.rawTitle || '',
                    source: 'zilean',
                    ...this.parseTorrentTitle(item.rawTitle || item.filename || '')
                }));

        } catch (err) {
            console.error(`[Torrent] Zilean error: ${err.message}`);
            return [];
        }
    }

    // Torrentio - FALLBACK (may block datacenter/VPN IPs)
    async searchTorrentio(type, imdbId) {
        try {
            const url = `${this.torrentioUrl}/stream/${type}/${imdbId}.json`;
            console.log(`[Torrent] Torrentio: ${url}`);

            const response = await fetch(url, {
                timeout: 15000,
                headers: { 'User-Agent': 'Stremio', 'Accept': 'application/json' }
            });

            if (response.status === 403) {
                console.log('[Torrent] Torrentio 403 — blocked');
                return [];
            }

            if (!response.ok) {
                console.log(`[Torrent] Torrentio returned ${response.status}`);
                return [];
            }

            const data = await response.json();
            if (!data.streams || data.streams.length === 0) {
                console.log('[Torrent] Torrentio returned no streams');
                return [];
            }

            console.log(`[Torrent] Torrentio returned ${data.streams.length} streams`);

            return data.streams
                .filter(s => s.infoHash)
                .map(s => ({
                    infoHash: s.infoHash.toLowerCase(),
                    title: s.title || 'Unknown',
                    fileIdx: s.fileIdx !== undefined ? s.fileIdx : null,
                    name: s.name || '',
                    source: 'torrentio',
                    ...this.parseTorrentTitle(s.title || '')
                }));

        } catch (err) {
            console.error(`[Torrent] Torrentio error: ${err.message}`);
            return [];
        }
    }

    // Jackett - optional
    async searchJackett(type, imdbId) {
        if (!this.jackettUrl || !this.jackettApiKey) return [];

        try {
            const cleanImdb = imdbId.split(':')[0];
            const category = type === 'movie' ? '2000' : '5000';
            const url = `${this.jackettUrl}/api/v2.0/indexers/all/results?apikey=${this.jackettApiKey}&Query=${cleanImdb}&Category[]=${category}`;

            console.log('[Torrent] Jackett search...');
            const response = await fetch(url, { timeout: 30000 });
            if (!response.ok) return [];

            const data = await response.json();
            if (!data.Results) return [];

            return data.Results
                .filter(r => r.MagnetUri || r.InfoHash)
                .map(r => ({
                    infoHash: (r.InfoHash || this.extractHashFromMagnet(r.MagnetUri)).toLowerCase(),
                    title: r.Title || 'Unknown',
                    fileIdx: null,
                    source: 'jackett',
                    ...this.parseTorrentTitle(r.Title || '')
                }))
                .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

        } catch (err) {
            console.error(`[Torrent] Jackett error: ${err.message}`);
            return [];
        }
    }

    // Combined search
    async search(type, imdbId) {
        console.log(`[Torrent] Searching for ${type}: ${imdbId}`);

        const results = await Promise.allSettled([
            this.searchZilean(type, imdbId),
            this.searchTorrentio(type, imdbId),
            this.searchJackett(type, imdbId)
        ]);

        const torrents = results
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value);

        const seen = new Set();
        const unique = torrents.filter(t => {
            if (seen.has(t.infoHash)) return false;
            seen.add(t.infoHash);
            return true;
        });

        console.log(`[Torrent] Total: ${unique.length} unique torrents`);
        return unique;
    }

    extractHashFromMagnet(magnetUri) {
        if (!magnetUri) return '';
        const match = magnetUri.match(/btih:([a-fA-F0-9]{40})/i);
        return match ? match[1] : '';
    }

    parseTorrentTitle(title) {
        const info = {};

        if (/2160p|4k|uhd/i.test(title)) info.quality = '4K';
        else if (/1080p/i.test(title)) info.quality = '1080p';
        else if (/720p/i.test(title)) info.quality = '720p';
        else if (/480p/i.test(title)) info.quality = '480p';
        else info.quality = 'Unknown';

        if (/blu-?ray|bdremux|bdrip/i.test(title)) info.sourceType = 'BluRay';
        else if (/web-?dl/i.test(title)) info.sourceType = 'WEB-DL';
        else if (/web-?rip/i.test(title)) info.sourceType = 'WEBRip';
        else if (/hdtv/i.test(title)) info.sourceType = 'HDTV';
        else info.sourceType = '';

        if (/hdr10\+/i.test(title)) info.hdr = 'HDR10+';
        else if (/dolby.?vision|dv/i.test(title)) info.hdr = 'DV';
        else if (/hdr/i.test(title)) info.hdr = 'HDR';
        else info.hdr = '';

        if (/x265|h\.?265|hevc/i.test(title)) info.codec = 'HEVC';
        else if (/x264|h\.?264|avc/i.test(title)) info.codec = 'AVC';
        else if (/av1/i.test(title)) info.codec = 'AV1';
        else info.codec = '';

        if (/atmos/i.test(title)) info.audio = 'Atmos';
        else if (/dts-?hd|dts.?ma/i.test(title)) info.audio = 'DTS-HD';
        else if (/truehd/i.test(title)) info.audio = 'TrueHD';
        else if (/dts/i.test(title)) info.audio = 'DTS';
        else if (/dd.?5\.1|ac3|dolby.?digital/i.test(title)) info.audio = 'DD5.1';
        else if (/aac/i.test(title)) info.audio = 'AAC';
        else info.audio = '';

        const sizeMatch = title.match(/([\d.]+)\s*(GB|MB)/i);
        if (sizeMatch) info.sizeStr = `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;

        return info;
    }
}

module.exports = TorrentProvider;
