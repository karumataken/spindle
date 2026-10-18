import { VINYL_COLORS } from './constants.js';
import { AppState, persistState, updateTrackPathsOnFolderRename } from './state.js';
import { renderSidebarView, updatePlayerUI, isPlaceholderArt, cleanPlaylistTitle, upgradeArtworkUrl, showAlertModal } from './ui.js';

let isInitialized = false;
const activeJobs = new Map();

export function initDownloadManager() {
    if (isInitialized) return;
    if (typeof window === 'undefined' || !window.spindleDesktop) return;
    isInitialized = true;

    // 1. Tracks discovered (1-2s after starting)
    window.spindleDesktop.onImportDiscovered((data) => {
        const { jobId, targetPlaylistId, isPlaylist, playlistTitle, playlistThumbnail, entries, entry } = data;
        const targetPl = AppState.playlists.find(p => p.id === targetPlaylistId);
        if (!targetPl) return;

        // Auto-assign playlist artwork if not already custom set or if currently placeholder
        const candidateArt = (!isPlaceholderArt(playlistThumbnail) ? upgradeArtworkUrl(playlistThumbnail) : null) ||
                             (entries?.find(e => !isPlaceholderArt(e.thumbnail)) ? upgradeArtworkUrl(entries.find(e => !isPlaceholderArt(e.thumbnail)).thumbnail) : null) ||
                             (!isPlaceholderArt(entry?.thumbnail) ? upgradeArtworkUrl(entry.thumbnail) : null) ||
                             (entries?.[0]?.id ? `https://i.ytimg.com/vi/${entries[0].id}/maxresdefault.jpg` : null) ||
                             (entry?.id ? `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg` : null);

        if (candidateArt && (!targetPl.artwork || isPlaceholderArt(targetPl.artwork))) {
            targetPl.artwork = candidateArt;
        }

        const job = activeJobs.get(jobId) || { targetPlaylistId, placeholderIds: [] };
        activeJobs.set(jobId, job);

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
                        isSynth: false,
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
            if (singleArt && (!targetPl.artwork || isPlaceholderArt(targetPl.artwork))) {
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
                    isSynth: false,
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
    window.spindleDesktop.onTrackReady((data) => {
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
                isSynth: false,
                isDownloading: false,
                url,
                filePath,
                artwork: trackThumb,
                labelColor: palette.label,
                accentColor: palette.accent
            };
            targetPl.trackIds.push(trackId);
        }

        const effectiveArt = trackThumb || track?.artwork;
        if (effectiveArt && (!targetPl.artwork || isPlaceholderArt(targetPl.artwork))) {
            targetPl.artwork = effectiveArt;
        }

        // Check if any tracks in playlist are still downloading
        const hasPending = targetPl.trackIds.some(id => AppState.tracksById[id]?.isDownloading);
        if (!hasPending) {
            targetPl.isDownloading = false;
        }

        persistState();
        renderSidebarView();
        updatePlayerUI();
    });

    // 3. Batch download completed
    window.spindleDesktop.onImportCompleted((data) => {
        const { jobId, targetPlaylistId } = data;
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
            persistState();
            renderSidebarView();
            updatePlayerUI();
        }
        activeJobs.delete(jobId);
    });

    // 4. Batch error
    window.spindleDesktop.onImportError((data) => {
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
}

export function startBackgroundImport({ url, targetPlaylistId, playlistName, placeholderId = null }) {
    if (typeof window === 'undefined' || !window.spindleDesktop) {
        showAlertModal('Desktop Feature', 'YouTube downloads are available in the Spindle desktop app.');
        return;
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    activeJobs.set(jobId, {
        targetPlaylistId,
        placeholderIds: placeholderId ? [placeholderId] : []
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
