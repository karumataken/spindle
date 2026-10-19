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

function _bytesToDataUrl(bytes, mime = 'image/jpeg') {
    if (!bytes || bytes.length < 16 || bytes.length > 4 * 1024 * 1024) return null;
    let detectedMime = mime;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        detectedMime = 'image/png';
    } else if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        detectedMime = 'image/jpeg';
    } else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        detectedMime = 'image/webp';
    }
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return `data:${detectedMime};base64,${btoa(chunks.join(''))}`;
}

function _decodeId3Text(bytes, encoding) {
    if (!bytes || bytes.length === 0) return '';
    try {
        let text = '';
        if (encoding === 0) {
            text = new TextDecoder('iso-8859-1').decode(bytes);
        } else if (encoding === 1) {
            text = new TextDecoder('utf-16').decode(bytes);
        } else if (encoding === 2) {
            text = new TextDecoder('utf-16be').decode(bytes);
        } else {
            text = new TextDecoder('utf-8').decode(bytes);
        }
        return text.replace(/\0/g, '').trim();
    } catch (_) {
        return '';
    }
}

function _parseApicFrame(bytes, isV22 = false) {
    if (!bytes || bytes.length < 16) return null;
    const encoding = bytes[0];
    let pos = 1;
    let mime = 'image/jpeg';

    if (isV22) {
        const fmt = String.fromCharCode(bytes[1], bytes[2], bytes[3]).toUpperCase();
        if (fmt === 'PNG') mime = 'image/png';
        pos = 4;
    } else {
        let mimeEnd = pos;
        while (mimeEnd < bytes.length && bytes[mimeEnd] !== 0) mimeEnd++;
        const rawMime = new TextDecoder('iso-8859-1').decode(bytes.subarray(pos, mimeEnd)).trim().toLowerCase();
        if (rawMime && rawMime.includes('/')) mime = rawMime;
        pos = mimeEnd + 1;
    }

    if (pos >= bytes.length) return null;
    // Skip picture type byte (1 byte)
    pos += 1;

    // Skip null-terminated description string (1-byte null for Latin1/UTF-8, 2-byte null for UTF-16)
    if (encoding === 1 || encoding === 2) {
        while (pos + 1 < bytes.length && !(bytes[pos] === 0 && bytes[pos + 1] === 0)) {
            pos += 2;
        }
        pos += 2;
    } else {
        while (pos < bytes.length && bytes[pos] !== 0) {
            pos += 1;
        }
        pos += 1;
    }

    if (pos >= bytes.length) return null;
    return _bytesToDataUrl(bytes.subarray(pos), mime);
}

// Rich audio metadata & embedded cover art parser for local files (ID3v2, FLAC, MP4/M4A)
export async function parseAudioTitleArtist(file) {
    const rawName = file.name.replace(/\.[^/.]+$/, '');
    let artist = 'Unknown Artist';
    let title = rawName;
    let album = '';
    let artwork = null;

    if (rawName.includes(' - ')) {
        const parts = rawName.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
    }

    try {
        const buffer = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
        const view = new DataView(buffer);
        const u8 = new Uint8Array(buffer);

        // 1. ID3v2 (MP3 / WAV / AIFF)
        if (view.byteLength > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
            const version = u8[3];
            const flags = u8[5];
            const tagSize = ((u8[6] & 0x7f) << 21) |
                            ((u8[7] & 0x7f) << 14) |
                            ((u8[8] & 0x7f) << 7) |
                            (u8[9] & 0x7f);
            const limit = Math.min(view.byteLength, tagSize + 10);
            let offset = 10;

            // Skip ID3v2 extended header if present
            if ((flags & 0x40) !== 0 && offset + 4 < limit) {
                const extSize = version === 4
                    ? ((u8[offset] & 0x7f) << 21) | ((u8[offset + 1] & 0x7f) << 14) | ((u8[offset + 2] & 0x7f) << 7) | (u8[offset + 3] & 0x7f)
                    : view.getUint32(offset);
                offset += version === 4 ? extSize : extSize + 4;
            }

            const headerLen = version === 2 ? 6 : 10;

            while (offset + headerLen < limit) {
                const frameID = version === 2
                    ? String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2])
                    : String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);

                if (!/^[A-Z0-9]{3,4}$/.test(frameID)) break;

                let frameSize = 0;
                if (version === 2) {
                    frameSize = (u8[offset + 3] << 16) | (u8[offset + 4] << 8) | u8[offset + 5];
                } else if (version === 4) {
                    frameSize = ((u8[offset + 4] & 0x7f) << 21) |
                                ((u8[offset + 5] & 0x7f) << 14) |
                                ((u8[offset + 6] & 0x7f) << 7) |
                                (u8[offset + 7] & 0x7f);
                } else {
                    frameSize = view.getUint32(offset + 4);
                }

                if (frameSize <= 0 || offset + headerLen + frameSize > limit) break;

                const payload = u8.subarray(offset + headerLen, offset + headerLen + frameSize);

                if (frameID === 'TIT2' || frameID === 'TT2' || frameID === 'TPE1' || frameID === 'TP1' || frameID === 'TALB' || frameID === 'TAL') {
                    const text = _decodeId3Text(payload.subarray(1), payload[0]);
                    if (text) {
                        if (frameID === 'TIT2' || frameID === 'TT2') title = text;
                        else if (frameID === 'TPE1' || frameID === 'TP1') artist = text;
                        else if (frameID === 'TALB' || frameID === 'TAL') album = text;
                    }
                } else if ((frameID === 'APIC' || frameID === 'PIC') && !artwork) {
                    artwork = _parseApicFrame(payload, version === 2);
                }

                offset += headerLen + frameSize;
            }
        }
        // 2. FLAC ('fLaC')
        else if (view.byteLength > 8 && u8[0] === 0x66 && u8[1] === 0x4C && u8[2] === 0x61 && u8[3] === 0x43) {
            let offset = 4;
            let isLast = false;
            while (!isLast && offset + 4 <= view.byteLength) {
                const header = u8[offset];
                isLast = (header & 0x80) !== 0;
                const blockType = header & 0x7f;
                const blockLen = (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3];
                offset += 4;
                if (offset + blockLen > view.byteLength) break;

                if (blockType === 4) {
                    // VORBIS_COMMENT (little-endian lengths)
                    let pos = offset;
                    const vendorLen = view.getUint32(pos, true);
                    pos += 4 + vendorLen;
                    if (pos + 4 <= offset + blockLen) {
                        const commentCount = view.getUint32(pos, true);
                        pos += 4;
                        for (let i = 0; i < commentCount && pos + 4 <= offset + blockLen; i++) {
                            const cLen = view.getUint32(pos, true);
                            pos += 4;
                            if (pos + cLen > offset + blockLen) break;
                            const entry = new TextDecoder('utf-8').decode(u8.subarray(pos, pos + cLen));
                            pos += cLen;
                            const eq = entry.indexOf('=');
                            if (eq > 0) {
                                const key = entry.slice(0, eq).toUpperCase();
                                const val = entry.slice(eq + 1).trim();
                                if (val) {
                                    if (key === 'TITLE') title = val;
                                    else if (key === 'ARTIST') artist = val;
                                    else if (key === 'ALBUM') album = val;
                                }
                            }
                        }
                    }
                } else if (blockType === 6 && !artwork) {
                    // METADATA_BLOCK_PICTURE (big-endian)
                    let pos = offset + 4; // skip picture type
                    if (pos + 4 <= offset + blockLen) {
                        const mimeLen = view.getUint32(pos);
                        pos += 4;
                        const mime = new TextDecoder('iso-8859-1').decode(u8.subarray(pos, pos + mimeLen)) || 'image/jpeg';
                        pos += mimeLen;
                        if (pos + 4 <= offset + blockLen) {
                            const descLen = view.getUint32(pos);
                            pos += 4 + descLen + 16; // skip width, height, depth, colors
                            if (pos + 4 <= offset + blockLen) {
                                const dataLen = view.getUint32(pos);
                                pos += 4;
                                if (pos + dataLen <= offset + blockLen) {
                                    artwork = _bytesToDataUrl(u8.subarray(pos, pos + dataLen), mime);
                                }
                            }
                        }
                    }
                }
                offset += blockLen;
            }
        }
        // 3. MP4 / M4A ('ftyp' at byte 4)
        else if (view.byteLength > 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
            const readAtomName = (off) => String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
            const walkAtoms = (start, end) => {
                let pos = start;
                while (pos + 8 <= end) {
                    let size = view.getUint32(pos);
                    const name = readAtomName(pos + 4);
                    if (size < 8 || pos + size > end) break;

                    if (name === 'moov' || name === 'udta' || name === 'ilst') {
                        walkAtoms(pos + 8, pos + size);
                    } else if (name === 'meta') {
                        walkAtoms(pos + 12, pos + size);
                    } else if (name === '\xA9nam' || name === '\xA9ART' || name === '\xA9alb' || name === 'covr') {
                        // Look for inner 'data' atom
                        let dPos = pos + 8;
                        while (dPos + 16 <= pos + size) {
                            const dSize = view.getUint32(dPos);
                            const dName = readAtomName(dPos + 4);
                            if (dSize < 16 || dPos + dSize > pos + size) break;
                            if (dName === 'data') {
                                const payload = u8.subarray(dPos + 16, dPos + dSize);
                                if (name === 'covr' && !artwork) {
                                    artwork = _bytesToDataUrl(payload);
                                } else {
                                    const text = new TextDecoder('utf-8').decode(payload).replace(/\0/g, '').trim();
                                    if (text) {
                                        if (name === '\xA9nam') title = text;
                                        else if (name === '\xA9ART') artist = text;
                                        else if (name === '\xA9alb') album = text;
                                    }
                                }
                                break;
                            }
                            dPos += dSize;
                        }
                    }
                    pos += size;
                }
            };
            walkAtoms(0, view.byteLength);
        }
    } catch (_) {}

    return { title, artist, album, artwork };
}
