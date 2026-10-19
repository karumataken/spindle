import { VINYL_COLORS } from './constants.js';
import { AppState, persistState, updateTrackPathsOnFolderRename } from './state.js';
import { renderSidebarView, updatePlayerUI, isPlaceholderArt, cleanPlaylistTitle, upgradeArtworkUrl, showAlertModal } from './ui.js';

let isInitialized = false;
const activeJobs = new Map();
let unsubscribeFns = [];

export function initDownloadManager() {
    if (isInitialized) return;
    if (typeof window === 'undefined' || !window.spindleDesktop) return;
    isInitialized = true;

    // 1. Tracks discovered (1-2s after starting)
    const offDiscovered = window.spindleDesktop.onImportDiscovered((data) => {
        const { jobId, targetPlaylistId, isPlaylist, playlistTitle, playlistThumbnail, entries, entry } = data;
        const targetPl = AppState.playlists.find(p => p.id === targetPlaylistId);
        if (!targetPl) return;

        const job = activeJobs.get(jobId) || { targetPlaylistId, placeholderIds: [], fromCreation: false };
        activeJobs.set(jobId, job);

        // Auto-assign playlist artwork ONLY during playlist creation if a true playlist thumbnail is present
        if (job.fromCreation && (!targetPl.artwork || isPlaceholderArt(targetPl.artwork))) {
            const truePlArt = (!isPlaceholderArt(playlistThumbnail)) ? upgradeArtworkUrl(playlistThumbnail) : null;
            if (truePlArt) {
                targetPl.artwork = truePlArt;
            }
        }

        const cleanedTitle = cleanPlaylistTitle(playlistTitle);

        if (isPlaylist && Array.isArray(entries) && entries.length > 0) {
            // If playlist had a generic title like "Importing Playlist...", rename to YouTube playlist title
            if (!targetPl.name || targetPl.name.startsWith('Importing') || targetPl.name.startsWith('Playlist #') || targetPl.name.startsWith('Album - ')) {
                if (cleanedTitle) {
                    const oldName = targetPl.name;
                    targetPl.name = cleanedTitle;
                    if (oldName && oldName !== cleanedTitle && typeof window !== 'undefined' && window.spindleDesktop?.renamePlaylistFolder) {
                        window.spindleDesktop.renamePlaylistFolder({
                            oldName,
                            newName: cleanedTitle
                        }).then(res => {
                            if (res && res.oldPath && res.newPath) {
                                if (updateTrackPathsOnFolderRename(res.oldPath, res.newPath)) {
                                    persistState();
                                }
                            }
                        }).catch(err => console.warn('Could not rename playlist folder on discovery:', err));
                    }
                }
            }

            // Remove any initial temporary single placeholder
            if (job.placeholderIds && job.placeholderIds.length > 0) {
                job.placeholderIds.forEach(phId => {
                    const idx = targetPl.trackIds.indexOf(phId);
                    if (idx !== -1) targetPl.trackIds.splice(idx, 1);
                    delete AppState.tracksById[phId];
                });
                job.placeholderIds = [];
            }

            entries.forEach((e) => {
                const trackId = `yt-${e.id || Math.random().toString(36).substring(2, 7)}`;
                const trackThumb = (!isPlaceholderArt(e.thumbnail) ? upgradeArtworkUrl(e.thumbnail) : null) ||
                                   (e.id ? `https://i.ytimg.com/vi/${e.id}/maxresdefault.jpg` : null);
                if (!AppState.tracksById[trackId]) {
                    const palette = VINYL_COLORS[Object.keys(AppState.tracksById).length % VINYL_COLORS.length];
                    AppState.tracksById[trackId] = {
                        id: trackId,
                        ytId: e.id,
                        title: e.title || 'Track',
                        artist: e.artist || 'Unknown Artist',
                        duration: e.duration || 180,
                        isDownloading: true,
                        url: null,
                        filePath: null,
                        artwork: trackThumb,
                        labelColor: palette.label,
                        accentColor: palette.accent
                    };
                }
                if (!targetPl.trackIds.includes(trackId)) {
                    targetPl.trackIds.push(trackId);
                }
            });

            targetPl.isDownloading = true;
            persistState();
            renderSidebarView();

        } else if (!isPlaylist && entry) {
            // Single video discovered
            if (!targetPl.name || targetPl.name.startsWith('Importing') || targetPl.name.startsWith('Playlist #')) {
                if (entry.title) {
                    const oldName = targetPl.name;
                    targetPl.name = entry.title;
                    if (oldName && oldName !== entry.title && typeof window !== 'undefined' && window.spindleDesktop?.renamePlaylistFolder) {
                        window.spindleDesktop.renamePlaylistFolder({
                            oldName,
                            newName: entry.title
                        }).then(res => {
                            if (res && res.oldPath && res.newPath) {
                                if (updateTrackPathsOnFolderRename(res.oldPath, res.newPath)) {
                                    persistState();
                                }
                            }
                        }).catch(err => console.warn('Could not rename single track folder on discovery:', err));
                    }
                }
            }
            const singleArt = (!isPlaceholderArt(entry.thumbnail) ? upgradeArtworkUrl(entry.thumbnail) : null) ||
                              (entry.id ? `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg` : null);
            if (job.fromCreation && singleArt && (!targetPl.artwork || isPlaceholderArt(targetPl.artwork))) {
                targetPl.artwork = singleArt;
            }

            let track = null;
            if (job.placeholderIds && job.placeholderIds.length > 0) {
                track = AppState.tracksById[job.placeholderIds[0]];
            }

            if (track) {
                track.ytId = entry.id;
                track.title = entry.title || track.title;
                track.artist = entry.artist || track.artist;
                track.duration = entry.duration || track.duration;
                if (singleArt && (!track.artwork || isPlaceholderArt(track.artwork))) {
                    track.artwork = singleArt;
                }
            } else {
                const trackId = `yt-${entry.id || Math.random().toString(36).substring(2, 7)}`;
                const palette = VINYL_COLORS[Object.keys(AppState.tracksById).length % VINYL_COLORS.length];
                AppState.tracksById[trackId] = {
                    id: trackId,
                    ytId: entry.id,
                    title: entry.title,
                    artist: entry.artist,
                    duration: entry.duration || 180,
                    isDownloading: true,
                    url: null,
                    filePath: null,
                    artwork: singleArt,
                    labelColor: palette.label,
                    accentColor: palette.accent
                };
                if (!targetPl.trackIds.includes(trackId)) {
                    targetPl.trackIds.push(trackId);
                }
            }

            targetPl.isDownloading = true;
            persistState();
            renderSidebarView();
        }
    });

    // 2. Individual track download & conversion completed
    const offTrackReady = window.spindleDesktop.onTrackReady((data) => {
        const { jobId, targetPlaylistId, ytId, title, artist, duration, filePath, url, artwork } = data;
        const targetPl = AppState.playlists.find(p => p.id === targetPlaylistId);
        if (!targetPl) return;

        // Find track by ytId or title or pick first downloading track
        let track = null;
        for (const tid of targetPl.trackIds) {
            const t = AppState.tracksById[tid];
            if (t && t.isDownloading) {
                if (t.ytId && t.ytId === ytId) {
                    track = t;
                    break;
                }
                if (t.title && title && t.title.toLowerCase() === title.toLowerCase()) {
                    track = t;
                    break;
                }
            }
        }

        if (!track) {
            // Find any downloading track
            for (const tid of targetPl.trackIds) {
                const t = AppState.tracksById[tid];
                if (t && t.isDownloading) {
                    track = t;
                    break;
                }
            }
        }

        const trackThumb = (!isPlaceholderArt(artwork) ? upgradeArtworkUrl(artwork) : null) ||
                           (ytId && ytId !== 'fallback' ? `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg` : null);

        if (track) {
            track.isDownloading = false;
            track.title = title || track.title;
            track.artist = artist || track.artist;
            track.duration = duration || track.duration;
            track.filePath = filePath;
            track.url = url;
            if (trackThumb && (!track.artwork || isPlaceholderArt(track.artwork))) {
                track.artwork = trackThumb;
            }
        } else {
            // Create track entry if not previously registered
            const trackId = `yt-${ytId || Math.random().toString(36).substring(2, 7)}`;
            const palette = VINYL_COLORS[Object.keys(AppState.tracksById).length % VINYL_COLORS.length];
            AppState.tracksById[trackId] = {
                id: trackId,
                ytId,
                title: title || 'Track',
                artist: artist || 'Unknown Artist',
                duration: duration || 180,
                isDownloading: false,
                url,
                filePath,
                artwork: trackThumb,
                labelColor: palette.label,
                accentColor: palette.accent
            };
            targetPl.trackIds.push(trackId);
        }


        // Check if any tracks in playlist are still downloading
        const hasPending = targetPl.trackIds.some(id => AppState.tracksById[id]?.isDownloading);
        if (!hasPending) {
            targetPl.isDownloading = false;
            delete targetPl.downloadStatus;
        } else if (targetPl.downloadStatus) {
            targetPl.downloadStatus = { stage: 'downloading', percent: null, message: 'Downloading next track...' };
        }

        persistState();
        renderSidebarView();
        updatePlayerUI();
    });

    // 2b. Live download / conversion progress
    let lastProgressRender = 0;
    const offProgress = window.spindleDesktop.onImportProgress
        ? window.spindleDesktop.onImportProgress((data) => {
            const { targetPlaylistId, percent, stage, message } = data || {};
            const targetPl = AppState.playlists.find(p => p.id === targetPlaylistId);
            if (!targetPl) return;
            targetPl.isDownloading = true;
            targetPl.downloadStatus = {
                percent: typeof percent === 'number' && Number.isFinite(percent) ? Math.round(percent) : null,
                stage: stage || 'downloading',
                message: message || 'Downloading...'
            };
            const now = Date.now();
            if (now - lastProgressRender > 250 || stage === 'converting' || stage === 'metadata') {
                lastProgressRender = now;
                renderSidebarView();
            }
        })
        : null;

    // 3. Batch download completed
    const offCompleted = window.spindleDesktop.onImportCompleted((data) => {
        const { jobId, targetPlaylistId, renamedFrom, renamedTo } = data;
        if (renamedFrom && renamedTo) {
            updateTrackPathsOnFolderRename(renamedFrom, renamedTo);
        }
        const targetPl = AppState.playlists.find(p => p.id === targetPlaylistId);
        if (targetPl) {
            // Remove any leftover downloading placeholders that never completed
            targetPl.trackIds = targetPl.trackIds.filter(id => {
                const t = AppState.tracksById[id];
                if (t && t.isDownloading && !t.url) {
                    delete AppState.tracksById[id];
                    return false;
                }
                return true;
            });
            targetPl.isDownloading = false;
            delete targetPl.downloadStatus;
            persistState();
            renderSidebarView();
            updatePlayerUI();
        }
        activeJobs.delete(jobId);
    });

    // 4. Batch error
    const offError = window.spindleDesktop.onImportError((data) => {
        const { jobId, targetPlaylistId, error } = data;
        console.warn('Import error:', error);
        const targetPl = AppState.playlists.find(p => p.id === targetPlaylistId);
        if (targetPl) {
            targetPl.trackIds = targetPl.trackIds.filter(id => {
                const t = AppState.tracksById[id];
                if (t && t.isDownloading && !t.url) {
                    delete AppState.tracksById[id];
                    return false;
                }
                return true;
            });
            targetPl.isDownloading = false;
            delete targetPl.downloadStatus;
            persistState();
            renderSidebarView();
        }
        let userMsg = 'Tracks could not be downloaded.';
        if (error) {
            if (error.includes('Music Premium')) {
                userMsg = 'These tracks are restricted to YouTube Music Premium members and no alternative audio was found.';
            } else if (error.includes('Video unavailable')) {
                userMsg = 'The requested video or playlist is unavailable.';
            } else {
                userMsg = `Download failed: ${error.slice(0, 150)}`;
            }
        }
        showAlertModal('Import Error', userMsg);
        activeJobs.delete(jobId);
    });

    unsubscribeFns = [offDiscovered, offTrackReady, offProgress, offCompleted, offError].filter(fn => typeof fn === 'function');
}

export function cancelPlaylistImports(playlistId) {
    if (!playlistId) return false;
    let cancelledAny = false;
    for (const [jobId, job] of activeJobs.entries()) {
        if (job.targetPlaylistId === playlistId) {
            cancelledAny = true;
            if (typeof window !== 'undefined' && window.spindleDesktop?.cancelImport) {
                window.spindleDesktop.cancelImport(jobId).catch(() => {});
            }
            activeJobs.delete(jobId);
        }
    }
    const targetPl = AppState.playlists.find(p => p.id === playlistId);
    if (targetPl) {
        targetPl.trackIds = targetPl.trackIds.filter(id => {
            const t = AppState.tracksById[id];
            if (t && t.isDownloading && !t.url) {
                delete AppState.tracksById[id];
                return false;
            }
            return true;
        });
        targetPl.isDownloading = false;
        delete targetPl.downloadStatus;
        persistState();
        renderSidebarView();
        updatePlayerUI();
    }
    return cancelledAny;
}

export function cleanupDownloadManager() {
    unsubscribeFns.forEach(fn => {
        try { fn(); } catch (_) {}
    });
    unsubscribeFns = [];
    activeJobs.clear();
    isInitialized = false;
}

export function startBackgroundImport({ url, targetPlaylistId, playlistName, placeholderId = null, fromCreation = false }) {
    if (typeof window === 'undefined' || !window.spindleDesktop) {
        showAlertModal('Desktop Feature', 'YouTube downloads are available in the Spindle desktop app.');
        return;
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    activeJobs.set(jobId, {
        targetPlaylistId,
        placeholderIds: placeholderId ? [placeholderId] : [],
        fromCreation: Boolean(fromCreation)
    });

    window.spindleDesktop.startImport({
        jobId,
        url,
        playlistName,
        targetPlaylistId
    }).catch(err => {
        console.error('Failed to trigger background import:', err);
    });

    return jobId;
}
