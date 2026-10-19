import './style.css';
import { storageDB } from './db.js';
import { AppState, getCurrentTrack, persistState, getViewedPlaylist, updateTrackPathsOnFolderRename } from './state.js';
import { audioEngine } from './audio.js';
import { Turntable3D } from './turntable.js';
import {
    setTurntable,
    getTurntable,
    renderSidebarView,
    updatePlayerUI,
    closeContextMenu,
    closeModal,
    togglePlayPause,
    stopPlayback,
    playNextTrack,
    playPrevTrack,
    handleTrackEnded,
    showCreatePlaylistModal,
    showChangePlaylistArtworkModal,
    showAddSongsModal,
    openPlaylistContextMenu,
    handleLocalFiles,
    formatTime,
    selectAndPlayTrack,
    isPlaceholderArt,
    cleanPlaylistTitle,
    upgradeArtworkUrl,
    handleAudioLoadError,
    initMediaSession,
    initUpdateChecker
} from './ui.js';
import { initDownloadManager, cleanupDownloadManager } from './downloadManager.js';

async function hydrateLibrary() {
    await storageDB.init();
    const saved = await storageDB.loadMetadata();

    if (saved && (saved.playlists || saved.tracks)) {
        AppState.tracksById = saved.tracks || {};
        AppState.playlists = Array.isArray(saved.playlists) ? saved.playlists : [];

        let libraryFixed = false;

        // Clean out any legacy demo synth tracks and default playlists from earlier versions
        for (const tid of Object.keys(AppState.tracksById)) {
            const t = AppState.tracksById[tid];
            if (t?.isSynth || tid.startsWith('synth-')) {
                delete AppState.tracksById[tid];
                libraryFixed = true;
            }
        }

        const initialPlCount = AppState.playlists.length;
        AppState.playlists = AppState.playlists.filter(pl => pl.id !== 'pl-default-1' && pl.id !== 'pl-default-2');
        if (AppState.playlists.length !== initialPlCount) {
            libraryFixed = true;
        }

        AppState.playlists.forEach(pl => {
            if (Array.isArray(pl.trackIds)) {
                const prevLen = pl.trackIds.length;
                pl.trackIds = pl.trackIds.filter(tid => AppState.tracksById[tid] && !tid.startsWith('synth-'));
                if (pl.trackIds.length !== prevLen) {
                    libraryFixed = true;
                }
            }
        });

        for (const track of Object.values(AppState.tracksById)) {
            if (track.filePath) {
                track.url = `spindle-media://local/${encodeURIComponent(track.filePath)}`;
            } else {
                const blob = await storageDB.getAudioBlob(track.id);
                if (blob) {
                    track.url = URL.createObjectURL(blob);
                }
            }
        }

        // Auto-heal existing playlists (clean "Album - " prefixes) and upgrade artwork
        for (const pl of AppState.playlists) {
            const cleaned = cleanPlaylistTitle(pl.name);
            if (cleaned && cleaned !== pl.name) {
                const oldName = pl.name;
                pl.name = cleaned;
                libraryFixed = true;
                if (typeof window !== 'undefined' && window.spindleDesktop?.renamePlaylistFolder) {
                    try {
                        const res = await window.spindleDesktop.renamePlaylistFolder({ oldName, newName: cleaned });
                        if (res && res.oldPath && res.newPath) {
                            updateTrackPathsOnFolderRename(res.oldPath, res.newPath);
                        }
                    } catch (_) {}
                }
            }
        }

        for (const track of Object.values(AppState.tracksById)) {
            if (isPlaceholderArt(track.artwork)) {
                if (track.ytId && track.ytId !== 'fallback') {
                    track.artwork = `https://i.ytimg.com/vi/${track.ytId}/maxresdefault.jpg`;
                    libraryFixed = true;
                } else {
                    track.artwork = null;
                }
            } else if (track.artwork) {
                const up = upgradeArtworkUrl(track.artwork);
                if (up !== track.artwork) {
                    track.artwork = up;
                    libraryFixed = true;
                }
            }
        }

        for (const pl of AppState.playlists) {
            if (isPlaceholderArt(pl.artwork)) {
                pl.artwork = null;
                libraryFixed = true;
            } else if (pl.artwork) {
                const up = upgradeArtworkUrl(pl.artwork);
                if (up !== pl.artwork) {
                    pl.artwork = up;
                    libraryFixed = true;
                }
            }
        }

        if (libraryFixed) {
            await persistState({ immediate: true });
        }

        // Prune any orphaned IndexedDB audio blobs no longer referenced by tracksById
        await storageDB.cleanupOrphanedBlobs(Object.keys(AppState.tracksById));
    } else {
        AppState.tracksById = {};
        AppState.playlists = [];
        await persistState({ immediate: true });
    }

    AppState.playingPlaylistId = null;
    AppState.hasActiveSession = false;
    AppState.currentIndex = 0;
}

async function initApp() {
    storageDB.onStorageError = (context, err) => {
        console.error(`[Spindle Storage Error] ${context}:`, err);
    };

    await hydrateLibrary();
    initDownloadManager();
    initUpdateChecker();
    initMediaSession();

    const turntableInstance = new Turntable3D('canvas-container');
    setTurntable(turntableInstance);

    // Audio engine callbacks
    audioEngine.setAudioElement(document.getElementById('html5-audio'));
    audioEngine.onTimeUpdate = () => updatePlayerUI();
    audioEngine.onLoadedMetadata = () => {
        renderSidebarView();
        updatePlayerUI();
    };
    audioEngine.onEnded = () => handleTrackEnded();
    audioEngine.onAudioError = (_err, track) => handleAudioLoadError(track);

    renderSidebarView();
    updatePlayerUI();

    // Initial Startup "Click to Open" Intro Transition
    const introOverlay = document.getElementById('intro-overlay');
    const introPrompt = document.getElementById('intro-prompt');
    const sidebarPanel = document.getElementById('sidebar-panel');
    const hudTop = document.getElementById('hud-top');
    const hudBottom = document.getElementById('hud-bottom-hint');

    let isIntroActive = true;
    function handleIntroOpen() {
        if (!isIntroActive) return;
        isIntroActive = false;

        // 1. Fade out intro prompt & disable click catcher immediately
        if (introOverlay) {
            introOverlay.style.pointerEvents = 'none';
            introOverlay.remove();
        }
        if (introPrompt) {
            introPrompt.classList.add('opacity-0');
            setTimeout(() => introPrompt.remove(), 700);
        }

        // 2. Slide sidebar panel into view from the left
        if (sidebarPanel) {
            sidebarPanel.classList.remove('intro-hidden');
            sidebarPanel.addEventListener('transitionend', () => {
                const tt = getTurntable();
                if (tt) tt.resize();
            }, { once: true });
        }

        // 3. Fade in HUD controls
        if (hudTop) {
            hudTop.classList.remove('opacity-0');
        }
        if (hudBottom) {
            hudBottom.classList.remove('opacity-0');
        }

        // 4. Open turntable cover & glide smoothly to ISO view
        const currentTurntable = getTurntable();
        if (currentTurntable) {
            currentTurntable.revealFromIntro();
        }

        window.removeEventListener('keydown', onIntroKey);
        window.removeEventListener('click', handleIntroOpen, true);
    }

    function onIntroKey(e) {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleIntroOpen();
        }
    }

    if (introOverlay) {
        introOverlay.addEventListener('click', handleIntroOpen);
    }
    window.addEventListener('click', handleIntroOpen, { capture: true, once: true });
    window.addEventListener('keydown', onIntroKey);

    window.addEventListener('click', () => closeContextMenu());

    // Search playlists & songs input
    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('btn-search-clear');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            AppState.searchQuery = e.target.value;
            if (searchClearBtn) {
                if (AppState.searchQuery.trim().length > 0) {
                    searchClearBtn.classList.remove('hidden');
                } else {
                    searchClearBtn.classList.add('hidden');
                }
            }
            renderSidebarView();
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (searchInput.value) {
                    searchInput.value = '';
                    AppState.searchQuery = '';
                    if (searchClearBtn) searchClearBtn.classList.add('hidden');
                    renderSidebarView();
                }
                searchInput.blur();
            }
        });
    }

    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            AppState.searchQuery = '';
            searchClearBtn.classList.add('hidden');
            renderSidebarView();
        });
    }

    // Global keyboard media shortcuts (Space, Arrow keys, M)
    window.addEventListener('keydown', (e) => {
        if (isIntroActive) return; // onIntroKey handles intro transition

        const activeEl = document.activeElement;
        const tagName = activeEl ? activeEl.tagName.toUpperCase() : '';
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || activeEl?.isContentEditable) {
            return; // Let user type normally into inputs
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            togglePlayPause();
            return;
        }

        if (e.key === 'ArrowLeft') {
            if (!AppState.hasActiveSession) return;
            e.preventDefault();
            if (e.shiftKey) {
                playPrevTrack();
            } else if (AppState.duration > 0) {
                audioEngine.seek(Math.max(0, AppState.currentTime - 5));
                updatePlayerUI();
            }
            return;
        }

        if (e.key === 'ArrowRight') {
            if (!AppState.hasActiveSession) return;
            e.preventDefault();
            if (e.shiftKey) {
                playNextTrack();
            } else if (AppState.duration > 0) {
                audioEngine.seek(Math.min(AppState.duration, AppState.currentTime + 5));
                updatePlayerUI();
            }
            return;
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (!AppState.hasActiveSession) return;
            e.preventDefault();
            const delta = e.key === 'ArrowUp' ? 0.05 : -0.05;
            const nextVol = Math.round(Math.max(0, Math.min(1, AppState.volume + delta)) * 100) / 100;
            AppState.isMuted = nextVol === 0;
            audioEngine.setVolume(nextVol);
            const volSliderEl = document.getElementById('vol-slider');
            const volFillEl = document.getElementById('vol-fill');
            if (volSliderEl) volSliderEl.value = String(nextVol);
            if (volFillEl) volFillEl.style.width = `${nextVol * 100}%`;
            return;
        }

        if (e.key === 'm' || e.key === 'M') {
            if (!AppState.hasActiveSession) return;
            e.preventDefault();
            AppState.isMuted = !AppState.isMuted;
            audioEngine.setVolume(AppState.volume);
            const volFillEl = document.getElementById('vol-fill');
            if (volFillEl) {
                volFillEl.style.width = AppState.isMuted ? '0%' : `${AppState.volume * 100}%`;
            }
        }
    });

    // Unfocus buttons on click so pressing space doesn't activate what was clicked last
    document.addEventListener('pointerup', (e) => {
        if (e.target.closest('button')) {
            if (document.activeElement && document.activeElement.tagName === 'BUTTON') {
                document.activeElement.blur();
            }
        }
    });

    // Compact Left-to-Right Light / Dark Theme Toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
        AppState.isDarkMode = !AppState.isDarkMode;
        document.body.classList.toggle('dark-theme', AppState.isDarkMode);

        const thumb = document.getElementById('theme-toggle-thumb');
        const lightLbl = document.getElementById('theme-label-light');
        const darkLbl = document.getElementById('theme-label-dark');

        if (AppState.isDarkMode) {
            thumb.style.transform = 'translateX(32px)';
            lightLbl.className = 'w-6 h-6 flex items-center justify-center text-muted transition-colors duration-300';
            darkLbl.className = 'w-6 h-6 flex items-center justify-center text-alabaster transition-colors duration-300';
        } else {
            thumb.style.transform = 'translateX(0px)';
            lightLbl.className = 'w-6 h-6 flex items-center justify-center text-alabaster transition-colors duration-300';
            darkLbl.className = 'w-6 h-6 flex items-center justify-center text-muted transition-colors duration-300';
        }

        const currentTurntable = getTurntable();
        if (currentTurntable) {
            currentTurntable.setTheme(AppState.isDarkMode);
        }
    });

    // Bind Transport Controls
    document.getElementById('btn-play').addEventListener('click', togglePlayPause);
    document.getElementById('btn-stop').addEventListener('click', stopPlayback);
    document.getElementById('btn-next').addEventListener('click', playNextTrack);
    document.getElementById('btn-prev').addEventListener('click', playPrevTrack);

    document.getElementById('btn-shuffle').addEventListener('click', () => {
        AppState.shuffleEnabled = !AppState.shuffleEnabled;
        updatePlayerUI();
    });

    document.getElementById('btn-repeat').addEventListener('click', () => {
        const modes = ['OFF', 'ALL', 'ONE'];
        AppState.repeatMode = modes[(modes.indexOf(AppState.repeatMode) + 1) % modes.length];
        updatePlayerUI();
    });

    // Opened Playlist Hero Controls
    document.getElementById('btn-back-playlists').addEventListener('click', () => {
        AppState.uiView = 'PLAYLISTS';
        AppState.isReorderMode = false;
        renderSidebarView();
        const currentTurntable = getTurntable();
        if (currentTurntable) {
            currentTurntable.setCameraView('side');
        }
    });

    document.getElementById('btn-hero-playlist-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        const pl = getViewedPlaylist();
        if (pl) openPlaylistContextMenu(e.currentTarget, pl);
    });

    document.getElementById('hero-playlist-artwork').addEventListener('click', () => {
        const pl = getViewedPlaylist();
        if (pl) showChangePlaylistArtworkModal(pl);
    });

    document.getElementById('btn-hero-play').addEventListener('click', () => {
        const pl = getViewedPlaylist();
        if (pl && pl.trackIds.length > 0) {
            const firstPlayableIdx = pl.trackIds.findIndex(id => {
                const t = AppState.tracksById[id];
                return t && !t.isDownloading;
            });
            if (firstPlayableIdx !== -1) {
                AppState.playingPlaylistId = pl.id;
                selectAndPlayTrack(firstPlayableIdx);
            }
        }
    });

    document.getElementById('btn-hero-add-songs').addEventListener('click', () => {
        if (AppState.viewedPlaylistId) {
            showAddSongsModal(AppState.viewedPlaylistId);
        }
    });

    document.getElementById('btn-toggle-reorder').addEventListener('click', () => {
        AppState.isReorderMode = !AppState.isReorderMode;
        renderSidebarView();
    });

    document.getElementById('btn-create-playlist').addEventListener('click', showCreatePlaylistModal);

    // Modal close handlers
    document.getElementById('modal-close').addEventListener('click', closeModal);
    const modalBackdrop = document.getElementById('modal-backdrop');
    modalBackdrop.addEventListener('click', (e) => {
        if (e.target === modalBackdrop) closeModal();
    });

    // Seek Slider
    const seekSlider = document.getElementById('seek-slider');
    seekSlider.addEventListener('input', (e) => {
        AppState.isSeeking = true;
        const ratio = parseFloat(e.target.value) / 1000;
        const previewTime = ratio * AppState.duration;
        document.getElementById('seek-fill').style.width = `${ratio * 100}%`;
        document.getElementById('time-current').textContent = formatTime(previewTime);
    });

    const commitSeek = () => {
        const ratio = parseFloat(seekSlider.value) / 1000;
        audioEngine.seek(ratio * AppState.duration);
        AppState.isSeeking = false;
        updatePlayerUI();
    };

    seekSlider.addEventListener('change', commitSeek);
    seekSlider.addEventListener('pointerup', commitSeek);

    // Volume & Mute
    const volSlider = document.getElementById('vol-slider');
    volSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        AppState.isMuted = val === 0;
        audioEngine.setVolume(val);
        document.getElementById('vol-fill').style.width = `${val * 100}%`;
    });

    document.getElementById('btn-mute').addEventListener('click', () => {
        AppState.isMuted = !AppState.isMuted;
        audioEngine.setVolume(AppState.volume);
        document.getElementById('vol-fill').style.width = AppState.isMuted ? '0%' : `${AppState.volume * 100}%`;
    });

    // Crackle Toggle
    document.getElementById('btn-crackle').addEventListener('click', () => {
        AppState.crackleEnabled = !AppState.crackleEnabled;
        const dot = document.getElementById('crackle-dot');
        dot.className = AppState.crackleEnabled
            ? 'w-2 h-2 rounded-full bg-terracotta'
            : 'w-2 h-2 rounded-full bg-stone';
        audioEngine.updateCrackleLevel();
    });

    // Acrylic Dust Cover Toggle
    const coverBtn = document.getElementById('btn-cover-toggle');
    coverBtn.addEventListener('click', () => {
        const currentTurntable = getTurntable();
        if (currentTurntable) {
            const isOpen = currentTurntable.toggleDustCover();
            coverBtn.className = isOpen
                ? 'px-2.5 py-1 rounded-xl font-mono text-[11px] text-espresso hover:bg-oatmeal transition'
                : 'px-2.5 py-1 rounded-xl font-mono text-[11px] bg-terracotta text-alabaster transition';
        }
    });

    // Manual Camera Angle Presets
    document.querySelectorAll('.cam-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const currentTurntable = getTurntable();
            if (currentTurntable) {
                currentTurntable.setCameraView(btn.dataset.cam);
            }
        });
    });

    // File Uploads & Drag-and-Drop
    document.getElementById('file-upload-audio').addEventListener('change', (e) => {
        handleLocalFiles(e.target.files, AppState.pendingAddSongsPlaylistId);
        AppState.pendingAddSongsPlaylistId = null;
        e.target.value = '';
    });

    document.getElementById('file-upload-artwork').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file && AppState.artworkUploadCallback) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                if (AppState.artworkUploadCallback) {
                    AppState.artworkUploadCallback(ev.target.result);
                    AppState.artworkUploadCallback = null;
                }
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });

    const dropOverlay = document.getElementById('drop-overlay');
    window.addEventListener('dragover', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            dropOverlay.classList.remove('hidden');
            dropOverlay.classList.add('flex');
        }
    });
    window.addEventListener('dragleave', (e) => {
        if (e.relatedTarget === null) {
            dropOverlay.classList.add('hidden');
            dropOverlay.classList.remove('flex');
        }
    });
    window.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            e.preventDefault();
            dropOverlay.classList.add('hidden');
            dropOverlay.classList.remove('flex');
            handleLocalFiles(e.dataTransfer.files);
        }
    });

    let rafId = null;
    function animate() {
        rafId = requestAnimationFrame(animate);
        const currentTurntable = getTurntable();
        if (currentTurntable) {
            currentTurntable.update();
        }
    }
    animate();

    window.addEventListener('beforeunload', () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        cleanupDownloadManager();
        for (const track of Object.values(AppState.tracksById)) {
            if (track && typeof track.url === 'string' && track.url.startsWith('blob:')) {
                URL.revokeObjectURL(track.url);
            }
        }
        const currentTurntable = getTurntable();
        if (currentTurntable && typeof currentTurntable.dispose === 'function') {
            currentTurntable.dispose();
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
