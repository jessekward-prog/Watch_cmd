const fetch = require('node-fetch');

const RD_BASE_URL = 'https://api.real-debrid.com/rest/1.0';

class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.headers = {
            'Authorization': `Bearer ${apiKey}`
        };
    }

    async request(method, endpoint, body = null) {
        const options = {
            method,
            headers: { ...this.headers }
        };

        if (body) {
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            options.body = new URLSearchParams(body).toString();
        }

        try {
            const response = await fetch(`${RD_BASE_URL}${endpoint}`, options);
            if (response.status === 204) return true;

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[RD] Error ${response.status} on ${endpoint}: ${errorText}`);
                return null;
            }

            const text = await response.text();
            if (!text) return true;
            return JSON.parse(text);
        } catch (err) {
            console.error(`[RD] Request failed on ${endpoint}: ${err.message}`);
            return null;
        }
    }

    async addMagnet(magnet) {
        return await this.request('POST', '/torrents/addMagnet', { magnet });
    }

    async getTorrentInfo(torrentId) {
        return await this.request('GET', `/torrents/info/${torrentId}`);
    }

    async selectFiles(torrentId, fileIds = 'all') {
        return await this.request('POST', `/torrents/selectFiles/${torrentId}`, {
            files: fileIds
        });
    }

    async unrestrictLink(link) {
        return await this.request('POST', '/unrestrict/link', { link });
    }

    async deleteTorrent(torrentId) {
        return await this.request('DELETE', `/torrents/delete/${torrentId}`);
    }

    async verifyApiKey() {
        const result = await this.request('GET', '/user');
        return result && result.username ? result : null;
    }

    // =========================================================================
    // Find the right file for a series episode
    // =========================================================================
    findEpisodeFile(files, season, episode) {
        if (!files || files.length === 0) return null;

        const videoExts = /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i;
        const videoFiles = files.filter(f => videoExts.test(f.path));

        const patterns = [
            new RegExp(`S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`, 'i'),
            new RegExp(`${season}x${String(episode).padStart(2, '0')}`, 'i'),
            new RegExp(`[._ -]${season}${String(episode).padStart(2, '0')}[._ -]`, 'i'),
        ];

        for (const pattern of patterns) {
            const match = videoFiles.find(f => pattern.test(f.path));
            if (match) return match;
        }

        return null;
    }

    // =========================================================================
    // Find the largest video file (for movies)
    // =========================================================================
    findLargestVideoFile(files) {
        if (!files || files.length === 0) return null;

        const videoExts = /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i;
        const videoFiles = files.filter(f => videoExts.test(f.path));

        if (videoFiles.length === 0) return null;

        return videoFiles.reduce((largest, f) =>
            f.bytes > (largest ? largest.bytes : 0) ? f : largest
        , null);
    }

    // =========================================================================
    // Resolve a torrent hash to a direct stream URL
    //
    // RD disabled /torrents/instantAvailability, so the new flow is:
    //   1. Add the magnet directly
    //   2. Select files
    //   3. Check torrent status:
    //      - "downloaded" = was cached, ready to stream
    //      - anything else = not cached, clean up and skip
    // =========================================================================
    async resolveStream(infoHash, fileIdx, season, episode) {
        let torrentId = null;

        try {
            const magnet = `magnet:?xt=urn:btih:${infoHash}`;

            // Step 1: Add the magnet
            const addResult = await this.addMagnet(magnet);
            if (!addResult || !addResult.id) {
                console.log(`[RD] Failed to add magnet: ${infoHash.substring(0, 8)}`);
                return null;
            }

            torrentId = addResult.id;

            // Step 2: Get torrent info
            let info = await this.getTorrentInfo(torrentId);
            if (!info) {
                await this.cleanupTorrent(torrentId);
                return null;
            }

            // Step 3: If waiting for file selection, select the right file
            if (info.status === 'waiting_files_selection') {
                let selectedFileId = 'all';

                if (season !== null && episode !== null && info.files) {
                    const epFile = this.findEpisodeFile(info.files, season, episode);
                    if (epFile) {
                        selectedFileId = String(epFile.id);
                        console.log(`[RD] Selected episode file: ${epFile.path}`);
                    }
                } else if (info.files) {
                    const bigFile = this.findLargestVideoFile(info.files);
                    if (bigFile) {
                        selectedFileId = String(bigFile.id);
                        console.log(`[RD] Selected largest file: ${bigFile.path}`);
                    }
                }

                await this.selectFiles(torrentId, selectedFileId);

                // Re-fetch info after selection
                info = await this.getTorrentInfo(torrentId);
                if (!info) {
                    await this.cleanupTorrent(torrentId);
                    return null;
                }
            }

            // Step 4: If status is "downloaded" it was cached and is ready
            if (info.status === 'downloaded' && info.links && info.links.length > 0) {
                // For multi-file torrents, pick the right link by matching info.files
                // RD links array is ordered the same as the selected files array
                let linkIdx = 0;
                if (info.files && info.links.length > 1) {
                    const selectedFiles = info.files.filter(f => f.selected === 1);
                    let targetFile = null;
                    if (season !== null && episode !== null) {
                        targetFile = this.findEpisodeFile(selectedFiles, season, episode);
                    } else {
                        targetFile = this.findLargestVideoFile(selectedFiles);
                    }
                    if (targetFile) {
                        const idx = selectedFiles.indexOf(targetFile);
                        if (idx >= 0 && idx < info.links.length) linkIdx = idx;
                    }
                }

                const link = info.links[linkIdx];
                const unrestricted = await this.unrestrictLink(link);

                if (unrestricted && unrestricted.download) {
                    return {
                        url: unrestricted.download,
                        filename: unrestricted.filename || '',
                        filesize: unrestricted.filesize || 0,
                        mimeType: unrestricted.mimeType || 'video/mp4'
                    };
                }
            }

            // Not cached — clean up so we don't clutter the user's torrent list
            console.log(`[RD] ${infoHash.substring(0, 8)} not cached (status: ${info.status})`);
            await this.cleanupTorrent(torrentId);
            return null;

        } catch (err) {
            console.error(`[RD] resolveStream error: ${err.message}`);
            if (torrentId) await this.cleanupTorrent(torrentId);
            return null;
        }
    }

    async cleanupTorrent(torrentId) {
        try {
            await this.deleteTorrent(torrentId);
        } catch (e) {
            // ignore cleanup errors
        }
    }
}

module.exports = RealDebridClient;
