import { storageDB } from './db.js';

export const AppState = {
    tracksById: {},
    playlists: [],
    uiView: 'PLAYLISTS',         // 'PLAYLISTS' (overview) | 'PLAYLIST_DETAIL' (opened playlist)
    viewedPlaylistId: null,
    playingPlaylistId: null,
    currentIndex: 0,
    hasActiveSession: false,     // Tracks whether a song has been started
    isReorderMode: false,
    playbackState: 'STOPPED',    // 'STOPPED' | 'PLAYING' | 'PAUSED'
    currentTime: 0,
    duration: 135,
    volume: 0.8,
    isMuted: false,
    crackleEnabled: true,
    rpmMode: 33.3,
    shuffleEnabled: false,
    repeatMode: 'OFF',           // 'OFF' | 'ALL' | 'ONE'
    isDarkMode: false,
    isSeeking: false,
    artworkUploadCallback: null,
    pendingAddSongsPlaylistId: null,
    searchQuery: ''
};

export function getPlayingPlaylist() {
    if (!AppState.playingPlaylistId) return null;
    return AppState.playlists.find(p => p.id === AppState.playingPlaylistId) || null;
}

export function getViewedPlaylist() {
    return AppState.playlists.find(p => p.id === AppState.viewedPlaylistId) || null;
}

export function getCurrentTrack() {
    const pl = getPlayingPlaylist();
    if (!pl || !pl.trackIds.length) return null;
    const tid = pl.trackIds[AppState.currentIndex] || pl.trackIds[0];
    return AppState.tracksById[tid] || null;
}

let _saveTimer = null;
let _saveInFlight = null;
let _pendingFlushAfterInFlight = false;
let _pendingResolvers = [];

async function _flushPersistQueue() {
    if (_saveTimer) {
        clearTimeout(_saveTimer);
        _saveTimer = null;
    }

    if (_saveInFlight) {
        _pendingFlushAfterInFlight = true;
        return _saveInFlight;
    }

    const resolvers = _pendingResolvers;
    _pendingResolvers = [];

    _saveInFlight = (async () => {
        try {
            return await storageDB.saveMetadata(AppState.tracksById, AppState.playlists);
        } finally {
            _saveInFlight = null;
            if (_pendingFlushAfterInFlight || _pendingResolvers.length > 0) {
                _pendingFlushAfterInFlight = false;
                await _flushPersistQueue();
            }
        }
    })();

    const result = await _saveInFlight;
    resolvers.forEach(r => r(result));
    return result;
}

export function persistState({ immediate = false } = {}) {
    if (immediate) {
        return _flushPersistQueue();
    }
    return new Promise((resolve) => {
        _pendingResolvers.push(resolve);
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            _flushPersistQueue();
        }, 120);
    });
}

// Updates track.filePath and track.url whenever a playlist folder is renamed on disk
export function updateTrackPathsOnFolderRename(oldFolderPath, newFolderPath) {
    if (!oldFolderPath || !newFolderPath || oldFolderPath === newFolderPath) return false;
    const normOld = oldFolderPath.replace(/[\\/]+$/, '');
    const normNew = newFolderPath.replace(/[\\/]+$/, '');
    let updated = false;

    for (const track of Object.values(AppState.tracksById)) {
        if (!track || !track.filePath) continue;
        if (
            track.filePath === normOld ||
            track.filePath.startsWith(normOld + '/') ||
            track.filePath.startsWith(normOld + '\\')
        ) {
            const suffix = track.filePath.slice(normOld.length);
            track.filePath = normNew + suffix;
            track.url = `spindle-media://local/${encodeURIComponent(track.filePath)}`;
            updated = true;
        }
    }
    return updated;
}

// Lightweight ID3v2 Title/Artist parser for local files
export async function parseAudioTitleArtist(file) {
    const rawName = file.name.replace(/\.[^/.]+$/, '');
    let artist = 'Unknown Artist';
    let title = rawName;
    if (rawName.includes(' - ')) {
        const parts = rawName.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
    }

    try {
        const buffer = await file.slice(0, 65536).arrayBuffer();
        const view = new DataView(buffer);
        if (view.byteLength > 10 && view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
            const version = view.getUint8(3);
            const tagSize = ((view.getUint8(6) & 0x7f) << 21) |
                            ((view.getUint8(7) & 0x7f) << 14) |
                            ((view.getUint8(8) & 0x7f) << 7) |
                            (view.getUint8(9) & 0x7f);
            const limit = Math.min(view.byteLength, tagSize + 10);
            let offset = 10;

            while (offset + 10 < limit) {
                const frameID = String.fromCharCode(
                    view.getUint8(offset),
                    view.getUint8(offset + 1),
                    view.getUint8(offset + 2),
                    view.getUint8(offset + 3)
                );
                if (!/^[A-Z0-9]{4}$/.test(frameID)) break;

                let frameSize = version === 4
                    ? ((view.getUint8(offset + 4) & 0x7f) << 21) |
                      ((view.getUint8(offset + 5) & 0x7f) << 14) |
                      ((view.getUint8(offset + 6) & 0x7f) << 7) |
                      (view.getUint8(offset + 7) & 0x7f)
                    : view.getUint32(offset + 4);

                if (frameSize <= 0 || offset + 10 + frameSize > limit) break;

                if (frameID === 'TIT2' || frameID === 'TPE1') {
                    const encoding = view.getUint8(offset + 10);
                    const bytes = new Uint8Array(buffer, offset + 11, frameSize - 1);
                    let text = '';
                    if (encoding === 0 || encoding === 3) {
                        text = new TextDecoder('utf-8').decode(bytes);
                    } else if (encoding === 1 || encoding === 2) {
                        text = new TextDecoder('utf-16').decode(bytes);
                    }
                    text = text.replace(/\0/g, '').trim();
                    if (text) {
                        if (frameID === 'TIT2') title = text;
                        if (frameID === 'TPE1') artist = text;
                    }
                }
                offset += 10 + frameSize;
            }
        }
    } catch (e) {}

    return { title, artist };
}
