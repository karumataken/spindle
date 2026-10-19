const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');

const ALLOWED_MEDIA_EXTENSIONS = new Set([
    '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm',
    '.jpg', '.jpeg', '.png', '.webp'
]);

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.mp3': return 'audio/mpeg';
        case '.wav': return 'audio/wav';
        case '.ogg':
        case '.opus': return 'audio/ogg';
        case '.flac': return 'audio/flac';
        case '.m4a':
        case '.aac': return 'audio/mp4';
        case '.webm': return 'audio/webm';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.png': return 'image/png';
        case '.webp': return 'image/webp';
        default: return 'audio/mpeg';
    }
}

// 1. Register privileged protocol for local audio streaming & seeking (HTTP range requests)
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'spindle-media',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            bypassCSP: true,
            corsEnabled: true
        }
    }
]);

let mainWindow = null;
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function getMusicDir() {
    const defaultMusic = app.getPath('music') || path.join(os.homedir(), 'Music');
    const spindleDir = path.join(defaultMusic, 'Spindle');
    if (!fs.existsSync(spindleDir)) {
        fs.mkdirSync(spindleDir, { recursive: true });
    }
    return spindleDir;
}

function sanitizeName(str) {
    const cleaned = (str || 'Track')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/\.+$/g, '')
        .trim();
    return cleaned || 'Track';
}

function isPathInsideMusicDir(targetPath) {
    try {
        const musicRoot = path.resolve(getMusicDir());
        const resolved = path.resolve(targetPath);
        const rel = path.relative(musicRoot, resolved);
        return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    } catch (_) {
        return false;
    }
}

function decodeMediaUrlPath(rawUrl) {
    let stripped = String(rawUrl || '').replace(/^spindle-media:\/\/local\/?/i, '');
    const qIdx = stripped.indexOf('?');
    if (qIdx !== -1) stripped = stripped.slice(0, qIdx);
    let decoded = decodeURIComponent(stripped);

    if (process.platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(decoded)) {
        decoded = decoded.slice(1);
    } else if (process.platform !== 'win32' && decoded && !decoded.startsWith('/')) {
        decoded = '/' + decoded;
    }
    return path.normalize(decoded);
}

function resolveAllowedMediaFile(requestedPath) {
    if (!requestedPath) return null;
    const ext = path.extname(requestedPath).toLowerCase();
    if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) return null;

    if (isPathInsideMusicDir(requestedPath) && fs.existsSync(requestedPath)) {
        return path.resolve(requestedPath);
    }

    // Fallback: if a playlist folder inside ~/Music/Spindle was renamed, locate by filename inside ~/Music/Spindle
    try {
        const base = path.basename(requestedPath);
        const musicDir = getMusicDir();
        if (base && fs.existsSync(musicDir)) {
            const directCandidate = path.join(musicDir, base);
            if (isPathInsideMusicDir(directCandidate) && fs.existsSync(directCandidate)) {
                return directCandidate;
            }
            const entries = fs.readdirSync(musicDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const candidate = path.join(musicDir, entry.name, base);
                    if (isPathInsideMusicDir(candidate) && fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            }
        }
    } catch (_) {}

    return null;
}

function findBinary(name) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid binary name: ${name}`);
    }
    const isWin = process.platform === 'win32';
    const exeName = isWin && !name.endsWith('.exe') ? `${name}.exe` : name;

    try {
        const lookupCmd = isWin ? 'where.exe' : 'which';
        const out = execFileSync(lookupCmd, [exeName], {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true
        }).trim();
        const firstLine = out.split(/\r?\n/)[0]?.trim();
        if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch (_) {}

    const commonPaths = [
        `/usr/bin/${exeName}`,
        `/usr/local/bin/${exeName}`,
        path.join(os.homedir(), '.local', 'bin', exeName),
        path.join(app.getAppPath(), 'bin', exeName)
    ];
    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }
    return exeName;
}

function createWindow() {
    app.setName('Spindle');
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 920,
        minHeight: 640,
        backgroundColor: '#1E1B18',
        title: 'Spindle',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false
        }
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';

    if (isDev && process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(devUrl);
    } else {
        const distIndex = path.join(__dirname, '../dist/index.html');
        if (fs.existsSync(distIndex)) {
            mainWindow.loadFile(distIndex);
        } else {
            mainWindow.loadURL(devUrl);
        }
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Setup custom streaming media protocol with full HTTP range seeking support
app.whenReady().then(() => {
    protocol.handle('spindle-media', async (request) => {
        try {
            const rawPath = decodeMediaUrlPath(request.url);
            const ext = path.extname(rawPath).toLowerCase();
            if (!ALLOWED_MEDIA_EXTENSIONS.has(ext) || !isPathInsideMusicDir(rawPath)) {
                return new Response('Forbidden media path', { status: 403 });
            }

            const filePath = resolveAllowedMediaFile(rawPath);
            if (!filePath || !fs.existsSync(filePath)) {
                return new Response('File not found', { status: 404 });
            }

            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                return new Response('Not a file', { status: 404 });
            }

            const totalSize = stat.size;
            const mimeType = getMimeType(filePath);
            const rangeHeader = request.headers.get('range');

            if (rangeHeader) {
                const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
                if (match) {
                    const start = parseInt(match[1], 10);
                    const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

                    if (start >= totalSize || end >= totalSize || start > end) {
                        return new Response('Requested range not satisfiable', {
                            status: 416,
                            headers: {
                                'Content-Range': `bytes */${totalSize}`,
                                'Accept-Ranges': 'bytes'
                            }
                        });
                    }

                    const chunkSize = (end - start) + 1;
                    const nodeStream = fs.createReadStream(filePath, { start, end });
                    const webStream = Readable.toWeb(nodeStream);

                    return new Response(webStream, {
                        status: 206,
                        statusText: 'Partial Content',
                        headers: {
                            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': String(chunkSize),
                            'Content-Type': mimeType,
                            'Cache-Control': 'no-cache'
                        }
                    });
                }
            }

            const nodeStream = fs.createReadStream(filePath);
            const webStream = Readable.toWeb(nodeStream);

            return new Response(webStream, {
                status: 200,
                headers: {
                    'Content-Length': String(totalSize),
                    'Accept-Ranges': 'bytes',
                    'Content-Type': mimeType,
                    'Cache-Control': 'no-cache'
                }
            });
        } catch (err) {
            console.error('Failed to load local media file:', err);
            return new Response('File not found', { status: 404 });
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handler: Basic App & System Info
ipcMain.handle('spindle:get-app-info', async () => {
    return {
        version: app.getVersion(),
        platform: process.platform,
        musicDir: getMusicDir(),
        isPackaged: app.isPackaged
    };
});

// IPC Handler: Verify yt-dlp & ffmpeg
ipcMain.handle('spindle:check-tools', async () => {
    let hasYtdlp = false;
    let hasFfmpeg = false;
    let ytdlpVersion = '';
    let ffmpegVersion = '';

    try {
        const yt = findBinary('yt-dlp');
        ytdlpVersion = execFileSync(yt, ['--version'], {
            encoding: 'utf8',
            timeout: 4000,
            windowsHide: true
        }).trim();
        hasYtdlp = true;
    } catch (_) {}

    try {
        const ff = findBinary('ffmpeg');
        const ffOut = execFileSync(ff, ['-version'], {
            encoding: 'utf8',
            timeout: 4000,
            windowsHide: true
        });
        ffmpegVersion = ffOut.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0];
        hasFfmpeg = true;
    } catch (_) {}

    return {
        hasYtdlp,
        hasFfmpeg,
        ytdlpVersion,
        ffmpegVersion
    };
});

function cleanPlaylistTitle(title) {
    if (!title || typeof title !== 'string') return '';
    return title.replace(/^(Album|EP|Single|Playlist)\s*[-–—:]\s*/i, '').trim();
}

function cleanArtist(artist) {
    if (!artist || typeof artist !== 'string') return 'Unknown Artist';
    let cleaned = artist.replace(/\s*-\s*Topic$/i, '').trim();
    cleaned = cleaned.replace(/\s*Topic$/i, '').trim();
    return cleaned || 'Unknown Artist';
}

function findCookiesFile(musicDir) {
    const candidatePaths = [
        path.join(musicDir, 'cookies.txt'),
        path.join(app.getPath('userData'), 'cookies.txt'),
        path.join(os.homedir(), '.config', 'spindle', 'cookies.txt')
    ];
    for (const cp of candidatePaths) {
        if (fs.existsSync(cp)) return cp;
    }
    return null;
}

function isPlaceholderThumbnail(url) {
    if (!url || typeof url !== 'string') return true;
    const lower = url.trim().toLowerCase();
    if (lower.length === 0) return true;
    if (lower.includes('no_thumbnail')) return true;
    if (lower.includes('unavailable')) return true;
    if (lower.includes('placeholder')) return true;
    if (lower.includes('desktop/unavailable')) return true;
    if (lower.includes('default_playlist')) return true;
    if (lower.includes('empty_playlist')) return true;
    if (lower.includes('/vi//')) return true;
    // Any /s_p/ thumbnail without a signed ?sqp= parameter is a broken phantom URL that returns YouTube's 404 placeholder
    if (lower.includes('/s_p/') && !lower.includes('sqp=')) {
        return true;
    }
    const viMatch = url.match(/\/vi(?:_webp)?\/([^/?#]+)/);
    if (viMatch) {
        const id = viMatch[1];
        if (id.length !== 11 || id.startsWith('PL') || id.startsWith('RD') || id.startsWith('UU') || id.startsWith('FL') || id.startsWith('OLAK')) {
            return true;
        }
    }
    return false;
}

function resolveBestThumbnail(item) {
    if (!item) return '';
    if (Array.isArray(item.thumbnails) && item.thumbnails.length > 0) {
        const valid = item.thumbnails.filter(t => t && t.url && !isPlaceholderThumbnail(t.url));
        if (valid.length > 0) {
            // Sort by resolution descending (width * height), fallback to index order
            valid.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
            const best = valid[0].url;
            const m = best.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
            if (m && !m[1].startsWith('PL') && !m[1].startsWith('OLAK')) {
                return `https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg`;
            }
            return best;
        }
    }
    if (item.thumbnail && !isPlaceholderThumbnail(item.thumbnail)) {
        const m = item.thumbnail.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
        if (m && !m[1].startsWith('PL') && !m[1].startsWith('OLAK')) {
            return `https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg`;
        }
        return item.thumbnail;
    }
    // Only construct maxresdefault if item.id is a genuine 11-character YouTube video ID (never a playlist or album ID)
    if (item.id && typeof item.id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(item.id) && !item.id.startsWith('PL') && !item.id.startsWith('OLAK')) {
        return `https://i.ytimg.com/vi/${item.id}/maxresdefault.jpg`;
    }
    return '';
}

// IPC Handler: Fast YouTube Video / Playlist Inspection (flat playlist, 1-2s response)
ipcMain.handle('spindle:youtube-inspect', async (_event, url) => {
    return new Promise((resolve, reject) => {
        if (!url || typeof url !== 'string') {
            return reject(new Error('Please provide a valid YouTube URL.'));
        }

        const ytBin = findBinary('yt-dlp');
        const nodeBin = findBinary('node');
        const cookiesFile = findCookiesFile(getMusicDir());

        const inspectArgs = [
            '--dump-single-json',
            '--flat-playlist',
            '--no-warnings',
            '--skip-download'
        ];
        if (nodeBin) inspectArgs.push('--js-runtimes', 'node');
        if (cookiesFile) inspectArgs.push('--cookies', cookiesFile);
        inspectArgs.push(url.trim());

        const proc = spawn(ytBin, inspectArgs);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(stderr || `yt-dlp exited with status code ${code}`));
            }

            try {
                const data = JSON.parse(stdout);

                if (data._type === 'playlist' || Array.isArray(data.entries)) {
                    const rawEntries = data.entries || [];
                    const entries = rawEntries.map(e => {
                        let t = (e.title || 'Track').trim();
                        let a = cleanArtist(e.artist || e.uploader || e.channel || 'Unknown Artist');
                        if (t.includes(' - ') && (!e.artist || a === cleanArtist(e.uploader))) {
                            const p = t.split(' - ');
                            a = cleanArtist(p[0]);
                            t = p.slice(1).join(' - ').trim();
                        }
                        const entryThumb = resolveBestThumbnail(e);
                        return {
                            id: e.id,
                            title: t,
                            artist: a,
                            duration: Math.round(e.duration || 180),
                            thumbnail: entryThumb
                        };
                    });

                    let plThumb = resolveBestThumbnail(data);
                    if (data.id && (data.id.startsWith('PL') || data.id.startsWith('RD') || data.id.startsWith('UU') || data.id.startsWith('FL')) && plThumb.includes('/vi/')) {
                        plThumb = '';
                    }
                    if (isPlaceholderThumbnail(plThumb)) {
                        plThumb = '';
                    }

                    return resolve({
                        isPlaylist: true,
                        id: data.id,
                        title: cleanPlaylistTitle(data.title) || 'Imported Playlist',
                        uploader: data.uploader || 'YouTube',
                        count: entries.length,
                        playlistThumbnail: plThumb,
                        thumbnail: plThumb,
                        entries
                    });
                }

                // Single video
                const thumb = resolveBestThumbnail(data);

                let title = (data.title || 'Unknown Title').trim();
                let artist = cleanArtist(data.artist || data.creator || data.uploader || 'YouTube');
                if (data.track) title = data.track.trim();
                if (data.artist) artist = cleanArtist(data.artist);

                if (title.includes(' - ') && (!data.artist || artist === cleanArtist(data.uploader))) {
                    const parts = title.split(' - ');
                    artist = cleanArtist(parts[0]);
                    title = parts.slice(1).join(' - ').trim();
                }

                resolve({
                    isPlaylist: false,
                    id: data.id,
                    title,
                    artist,
                    duration: Math.round(data.duration || 180),
                    playlistThumbnail: thumb,
                    thumbnail: thumb,
                    webpage_url: data.webpage_url || url
                });
            } catch (err) {
                reject(new Error('Failed to parse metadata: ' + err.message));
            }
        });
    });
});

// Track active import child processes for cancellation and clean app shutdown
const activeImportJobs = new Map();

function killJobProcesses(jobState) {
    if (!jobState) return;
    if (jobState.safetyTimer) {
        clearTimeout(jobState.safetyTimer);
        jobState.safetyTimer = null;
    }
    for (const key of ['inspectProc', 'dlProc', 'fbProc']) {
        const proc = jobState[key];
        if (proc && !proc.killed) {
            try { proc.kill('SIGTERM'); } catch (_) {}
        }
        jobState[key] = null;
    }
}

app.on('before-quit', () => {
    for (const jobState of activeImportJobs.values()) {
        jobState.cancelled = true;
        killJobProcesses(jobState);
    }
    activeImportJobs.clear();
});

ipcMain.handle('spindle:cancel-import', async (_event, jobId) => {
    const jobState = activeImportJobs.get(jobId);
    if (!jobState) return { cancelled: false };
    jobState.cancelled = true;
    killJobProcesses(jobState);
    activeImportJobs.delete(jobId);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('spindle:import-completed', {
            jobId,
            targetPlaylistId: jobState.targetPlaylistId,
            cancelled: true,
            success: false,
            count: 0
        });
    }
    return { cancelled: true };
});

// IPC Handler: Start Background Download (Fire-and-Forget, streaming per-track completions)
ipcMain.handle('spindle:start-import', async (event, { jobId, url, playlistName, targetPlaylistId }) => {
    if (!url || typeof url !== 'string') {
        throw new Error('Valid URL required');
    }

    const musicDir = getMusicDir();
    const ytBin = findBinary('yt-dlp');
    const ffBin = findBinary('ffmpeg');
    const nodeBin = findBinary('node');
    const cookiesFile = findCookiesFile(musicDir);

    const sendToWindow = (channel, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, data);
        }
    };

    const jobState = {
        jobId,
        targetPlaylistId,
        inspectProc: null,
        dlProc: null,
        fbProc: null,
        safetyTimer: null,
        cancelled: false
    };
    activeImportJobs.set(jobId, jobState);

    let resolvedPlaylistName = playlistName;
    let plFolder = null;
    let dlProcStarted = false;
    let discoveredEntries = [];

    const startDownload = (folderPath, expectedEntries = []) => {
        if (dlProcStarted || jobState.cancelled) return;
        dlProcStarted = true;
        if (jobState.safetyTimer) {
            clearTimeout(jobState.safetyTimer);
            jobState.safetyTimer = null;
        }

        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }

        const outputTemplate = path.join(folderPath, '%(title)s.%(ext)s');
        const dlArgs = [
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '0', // Best 320kbps
            '--embed-thumbnail',
            '--add-metadata',
            '--ignore-errors',
            '--no-warnings',
            '--ffmpeg-location', path.dirname(ffBin),
            '--output', outputTemplate,
            '--print', 'after_move:SPINDLE_READY\t%(id)s\t%(title)s\t%(artist,uploader)s\t%(duration)s\t%(filepath)s\t%(thumbnail)s',
            '--newline'
        ];
        if (nodeBin) dlArgs.push('--js-runtimes', 'node');
        if (cookiesFile) dlArgs.push('--cookies', cookiesFile);
        dlArgs.push(url.trim());

        const dlProc = spawn(ytBin, dlArgs);
        jobState.dlProc = dlProc;
        let dlStderr = '';
        const completedTracks = [];

        dlProc.stdout.on('data', (d) => {
            if (jobState.cancelled) return;
            const text = d.toString();
            const lines = text.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('SPINDLE_READY\t')) {
                    const parts = trimmed.replace('SPINDLE_READY\t', '').split('\t');
                    const [ytId, title, artist, durationStr, targetFile, thumbUrl] = parts;
                    if (targetFile && fs.existsSync(targetFile)) {
                        const mediaUrl = `spindle-media://local/${encodeURIComponent(targetFile)}`;
                        let trackThumb = (thumbUrl && !isPlaceholderThumbnail(thumbUrl)) ? thumbUrl : '';
                        if (!trackThumb && ytId && ytId !== 'fallback') {
                            trackThumb = `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`;
                        }
                        const trackObj = {
                            jobId,
                            targetPlaylistId,
                            ytId,
                            title: title || path.basename(targetFile, '.mp3'),
                            artist: cleanArtist(artist),
                            duration: parseFloat(durationStr) || 180,
                            filePath: targetFile,
                            url: mediaUrl,
                            artwork: trackThumb
                        };
                        completedTracks.push(trackObj);
                        sendToWindow('spindle:track-ready', trackObj);
                    }
                    continue;
                }

                // Download percentage parsing
                const progressMatch = trimmed.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
                if (progressMatch) {
                    sendToWindow('spindle:import-progress', {
                        jobId,
                        targetPlaylistId,
                        percent: parseFloat(progressMatch[1]),
                        size: progressMatch[2],
                        speed: progressMatch[3],
                        eta: progressMatch[4],
                        stage: 'downloading',
                        message: `Downloading: ${progressMatch[1]}% (${progressMatch[3]})`
                    });
                    continue;
                }

                if (trimmed.includes('[ExtractAudio]')) {
                    sendToWindow('spindle:import-progress', {
                        jobId,
                        targetPlaylistId,
                        stage: 'converting',
                        message: 'Extracting high-quality MP3...'
                    });
                    continue;
                }

                if (trimmed.includes('[EmbedThumbnail]') || trimmed.includes('[Metadata]')) {
                    sendToWindow('spindle:import-progress', {
                        jobId,
                        targetPlaylistId,
                        stage: 'metadata',
                        message: 'Embedding artwork and ID3 tags...'
                    });
                    continue;
                }
            }
        });

        dlProc.stderr.on('data', d => { dlStderr += d.toString(); });

        dlProc.on('close', async (code) => {
            jobState.dlProc = null;
            if (jobState.cancelled) {
                activeImportJobs.delete(jobId);
                return;
            }

            // Fallback: If no SPINDLE_READY lines were captured (or partial download), inspect folder for new mp3s
            if (completedTracks.length === 0 && fs.existsSync(folderPath)) {
                const files = fs.readdirSync(folderPath)
                    .filter(f => f.toLowerCase().endsWith('.mp3'))
                    .map(f => ({ name: f, time: fs.statSync(path.join(folderPath, f)).mtimeMs }))
                    .sort((a, b) => b.time - a.time);

                if (files.length > 0) {
                    const recent = files[0];
                    const fullP = path.join(folderPath, recent.name);
                    const mediaUrl = `spindle-media://local/${encodeURIComponent(fullP)}`;
                    let t = recent.name.replace(/\.mp3$/i, '');
                    let a = 'Unknown Artist';
                    if (t.includes(' - ')) {
                        const p = t.split(' - ');
                        a = cleanArtist(p[0]);
                        t = p.slice(1).join(' - ').trim();
                    }
                    const fallbackTrack = {
                        jobId,
                        targetPlaylistId,
                        ytId: 'fallback',
                        title: t,
                        artist: a,
                        duration: 180,
                        filePath: fullP,
                        url: mediaUrl
                    };
                    completedTracks.push(fallbackTrack);
                    sendToWindow('spindle:track-ready', fallbackTrack);
                }
            }

            // Fallback Search Resolution for Missing / Gated Tracks
            // When YouTube Music Premium or region locks prevent direct download, search for individual tracks
            const completedYtIds = new Set(completedTracks.map(t => t.ytId));
            const completedTitles = new Set(completedTracks.map(t => t.title.toLowerCase().trim()));

            const tracksToResolve = (expectedEntries && expectedEntries.length > 0) ? expectedEntries : discoveredEntries;
            const missingEntries = tracksToResolve.filter(e => {
                if (!e) return false;
                if (completedYtIds.has(e.id)) return false;
                if (e.title && completedTitles.has(e.title.toLowerCase().trim())) return false;
                return true;
            });

            if (missingEntries.length > 0 && !jobState.cancelled) {
                sendToWindow('spindle:import-progress', {
                    jobId,
                    targetPlaylistId,
                    stage: 'downloading',
                    message: `Resolving ${missingEntries.length} track${missingEntries.length > 1 ? 's' : ''} via YouTube search...`
                });

                for (let i = 0; i < missingEntries.length; i++) {
                    if (jobState.cancelled) break;
                    const item = missingEntries[i];
                    const cleanTit = (item.title || 'Track').trim();
                    const cleanArt = cleanArtist(item.artist);

                    sendToWindow('spindle:import-progress', {
                        jobId,
                        targetPlaylistId,
                        stage: 'downloading',
                        percent: Math.round(((i + 1) / missingEntries.length) * 100),
                        message: `Searching audio for: ${cleanTit} (${i + 1}/${missingEntries.length})...`
                    });

                    const searchQuery = cleanArt && cleanArt !== 'Unknown Artist'
                        ? `ytsearch1:${cleanArt} ${cleanTit}`
                        : `ytsearch1:${cleanTit}`;

                    const trackOutputFile = path.join(folderPath, `${sanitizeName(cleanTit)}.%(ext)s`);

                    const fallbackArgs = [
                        '--extract-audio',
                        '--audio-format', 'mp3',
                        '--audio-quality', '0',
                        '--embed-thumbnail',
                        '--add-metadata',
                        '--no-warnings',
                        '--ffmpeg-location', path.dirname(ffBin),
                        '--output', trackOutputFile,
                        '--print', 'after_move:SPINDLE_READY\t%(id)s\t%(title)s\t%(artist,uploader)s\t%(duration)s\t%(filepath)s\t%(thumbnail)s',
                        '--newline'
                    ];
                    if (nodeBin) fallbackArgs.push('--js-runtimes', 'node');
                    if (cookiesFile) fallbackArgs.push('--cookies', cookiesFile);
                    fallbackArgs.push(searchQuery);

                    try {
                        await new Promise((resolve) => {
                            const fbProc = spawn(ytBin, fallbackArgs);
                            jobState.fbProc = fbProc;
                            let fbOut = '';
                            fbProc.stdout.on('data', d => { fbOut += d.toString(); });
                            fbProc.on('close', () => {
                                jobState.fbProc = null;
                                if (jobState.cancelled) {
                                    resolve();
                                    return;
                                }
                                const fbLines = fbOut.split('\n');
                                for (const l of fbLines) {
                                    const trimmedLine = l.trim();
                                    if (trimmedLine.startsWith('SPINDLE_READY\t')) {
                                        const parts = trimmedLine.replace('SPINDLE_READY\t', '').split('\t');
                                        const [actualYtId, actualTitle, actualArtist, durationStr, targetFile, thumbUrl] = parts;
                                        if (targetFile && fs.existsSync(targetFile)) {
                                            const mediaUrl = `spindle-media://local/${encodeURIComponent(targetFile)}`;
                                            const effectiveArt = (!isPlaceholderThumbnail(item.thumbnail) ? item.thumbnail : '') ||
                                                                 (!isPlaceholderThumbnail(thumbUrl) ? thumbUrl : '') ||
                                                                 (actualYtId ? `https://i.ytimg.com/vi/${actualYtId}/maxresdefault.jpg` : '');
                                            const trackObj = {
                                                jobId,
                                                targetPlaylistId,
                                                ytId: item.id, // Keeps placeholder match intact
                                                actualYtId,
                                                title: cleanTit,
                                                artist: cleanArt || cleanArtist(actualArtist) || 'Unknown Artist',
                                                duration: parseFloat(durationStr) || item.duration || 180,
                                                filePath: targetFile,
                                                url: mediaUrl,
                                                artwork: effectiveArt
                                            };
                                            completedTracks.push(trackObj);
                                            sendToWindow('spindle:track-ready', trackObj);
                                        }
                                        break;
                                    }
                                }
                                resolve();
                            });
                        });
                    } catch (fbErr) {
                        console.warn(`Fallback search download failed for ${cleanTit}:`, fbErr);
                    }
                }
            }

            if (jobState.cancelled) {
                activeImportJobs.delete(jobId);
                return;
            }

            if (code === 0 || completedTracks.length > 0) {
                let renamedFrom = null;
                let renamedTo = null;
                if (resolvedPlaylistName && plFolder) {
                    const targetDir = path.join(musicDir, sanitizeName(resolvedPlaylistName));
                    if (plFolder !== targetDir && fs.existsSync(plFolder)) {
                        const oldFolder = plFolder;
                        try {
                            if (!fs.existsSync(targetDir)) {
                                fs.renameSync(plFolder, targetDir);
                                plFolder = targetDir;
                                renamedFrom = oldFolder;
                                renamedTo = targetDir;
                            } else {
                                const files = fs.readdirSync(plFolder);
                                for (const f of files) {
                                    const src = path.join(plFolder, f);
                                    const dst = path.join(targetDir, f);
                                    if (!fs.existsSync(dst)) fs.renameSync(src, dst);
                                }
                                try { fs.rmdirSync(plFolder); } catch (_) {}
                                plFolder = targetDir;
                                renamedFrom = oldFolder;
                                renamedTo = targetDir;
                            }
                        } catch (err) {
                            console.warn('Could not rename import folder at completion:', err);
                        }
                    }
                }

                sendToWindow('spindle:import-completed', {
                    jobId,
                    targetPlaylistId,
                    success: true,
                    count: completedTracks.length,
                    renamedFrom,
                    renamedTo
                });
            } else {
                sendToWindow('spindle:import-error', {
                    jobId,
                    targetPlaylistId,
                    error: dlStderr || `yt-dlp exited with code ${code}`
                });
            }
            activeImportJobs.delete(jobId);
        });
    };

    // Step 1: Quick inspection in parallel to populate playlist with placeholder tracks
    const inspectArgs = [
        '--dump-single-json',
        '--flat-playlist',
        '--no-warnings',
        '--skip-download'
    ];
    if (nodeBin) inspectArgs.push('--js-runtimes', 'node');
    if (cookiesFile) inspectArgs.push('--cookies', cookiesFile);
    inspectArgs.push(url.trim());

    const inspectProc = spawn(ytBin, inspectArgs);
    jobState.inspectProc = inspectProc;

    let inspectStdout = '';
    inspectProc.stdout.on('data', d => { inspectStdout += d.toString(); });
    inspectProc.on('close', code => {
        jobState.inspectProc = null;
        if (jobState.cancelled) return;
        if (code === 0) {
            try {
                const data = JSON.parse(inspectStdout);
                if (data._type === 'playlist' || Array.isArray(data.entries)) {
                    const rawEntries = data.entries || [];
                    const entries = rawEntries.map(e => {
                        let t = (e.title || 'Track').trim();
                        let a = cleanArtist(e.artist || e.uploader || e.channel || 'Unknown Artist');
                        if (t.includes(' - ') && (!e.artist || a === cleanArtist(e.uploader))) {
                            const p = t.split(' - ');
                            a = cleanArtist(p[0]);
                            t = p.slice(1).join(' - ').trim();
                        }
                        const entryThumb = resolveBestThumbnail(e);
                        return {
                            id: e.id,
                            title: t,
                            artist: a,
                            duration: Math.round(e.duration || 180),
                            thumbnail: entryThumb
                        };
                    });

                    let plThumb = resolveBestThumbnail(data);
                    if (data.id && (data.id.startsWith('PL') || data.id.startsWith('RD') || data.id.startsWith('UU') || data.id.startsWith('FL')) && plThumb.includes('/vi/')) {
                        plThumb = '';
                    }
                    if (isPlaceholderThumbnail(plThumb)) {
                        plThumb = '';
                    }

                    const discoveredTitle = cleanPlaylistTitle(data.title) || playlistName;
                    resolvedPlaylistName = discoveredTitle;
                    plFolder = path.join(musicDir, sanitizeName(resolvedPlaylistName));
                    discoveredEntries = entries;

                    sendToWindow('spindle:import-discovered', {
                        jobId,
                        targetPlaylistId,
                        isPlaylist: true,
                        playlistTitle: discoveredTitle,
                        playlistThumbnail: plThumb,
                        entries
                    });

                    startDownload(plFolder, entries);
                } else {
                    let t = (data.title || 'Track').trim();
                    let a = cleanArtist(data.artist || data.uploader || 'YouTube');
                    if (data.track) t = data.track.trim();
                    if (t.includes(' - ') && (!data.artist || a === cleanArtist(data.uploader))) {
                        const p = t.split(' - ');
                        a = cleanArtist(p[0]);
                        t = p.slice(1).join(' - ').trim();
                    }
                    const vidThumb = resolveBestThumbnail(data);

                    const isGenericName = !playlistName || playlistName.startsWith('Importing') || playlistName.startsWith('Playlist #');
                    resolvedPlaylistName = isGenericName ? t : (playlistName || t);
                    plFolder = path.join(musicDir, sanitizeName(resolvedPlaylistName));

                    const singleEntry = {
                        id: data.id,
                        title: t,
                        artist: a,
                        duration: Math.round(data.duration || 180),
                        thumbnail: vidThumb
                    };
                    discoveredEntries = [singleEntry];

                    sendToWindow('spindle:import-discovered', {
                        jobId,
                        targetPlaylistId,
                        isPlaylist: false,
                        playlistTitle: resolvedPlaylistName,
                        playlistThumbnail: vidThumb,
                        entry: singleEntry
                    });

                    startDownload(plFolder, [singleEntry]);
                }
            } catch (_) {
                plFolder = path.join(musicDir, sanitizeName(playlistName || 'Downloads'));
                startDownload(plFolder, []);
            }
        } else {
            plFolder = path.join(musicDir, sanitizeName(playlistName || 'Downloads'));
            startDownload(plFolder, []);
        }
    });

    // Safety timeout: If inspection hangs longer than 15 seconds, start downloading to fallback folder
    jobState.safetyTimer = setTimeout(() => {
        jobState.safetyTimer = null;
        if (!dlProcStarted && !jobState.cancelled) {
            plFolder = path.join(musicDir, sanitizeName(playlistName || 'Downloads'));
            startDownload(plFolder, discoveredEntries);
        }
    }, 15000);

    return { started: true, jobId };
});


// IPC Handler: Rename local playlist folder
ipcMain.handle('spindle:rename-playlist-folder', async (_event, { oldName, newName }) => {
    try {
        if (!oldName || !newName || oldName === newName) return { success: true };
        const musicDir = getMusicDir();
        const oldPath = path.join(musicDir, sanitizeName(oldName));
        const newPath = path.join(musicDir, sanitizeName(newName));

        if (!isPathInsideMusicDir(oldPath) || !isPathInsideMusicDir(newPath)) {
            return { success: false, error: 'Invalid playlist path' };
        }

        if (fs.existsSync(oldPath) && oldPath !== newPath) {
            if (!fs.existsSync(newPath)) {
                fs.renameSync(oldPath, newPath);
            } else {
                const files = fs.readdirSync(oldPath);
                for (const f of files) {
                    const src = path.join(oldPath, f);
                    const dst = path.join(newPath, f);
                    if (!fs.existsSync(dst)) {
                        fs.renameSync(src, dst);
                    }
                }
                try { fs.rmdirSync(oldPath); } catch (_) {}
            }
        }
        return { success: true, oldPath, newPath };
    } catch (err) {
        console.error('Failed to rename playlist folder:', err);
        return { success: false, error: err.message };
    }
});

// IPC Handler: Delete local playlist folder and all files
ipcMain.handle('spindle:delete-playlist-folder', async (_event, folderName) => {
    try {
        if (!folderName) return { success: false, error: 'Folder name required' };
        const musicDir = getMusicDir();
        const target = path.join(musicDir, sanitizeName(folderName));
        if (!isPathInsideMusicDir(target) || path.resolve(target) === path.resolve(musicDir)) {
            return { success: false, error: 'Invalid target folder' };
        }
        if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
        return { success: true };
    } catch (err) {
        console.error('Failed to delete playlist folder:', err);
        return { success: false, error: err.message };
    }
});

// IPC Handler: Open local music folder in system file manager
ipcMain.handle('spindle:open-music-folder', async (_event, subPath) => {
    const musicDir = getMusicDir();
    const candidate = subPath ? path.join(musicDir, sanitizeName(subPath)) : musicDir;
    const target = isPathInsideMusicDir(candidate) ? candidate : musicDir;
    if (fs.existsSync(target)) {
        await shell.openPath(target);
    } else {
        await shell.openPath(musicDir);
    }
    return true;
});
