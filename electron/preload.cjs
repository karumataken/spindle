const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spindleDesktop', {
    isDesktop: true,
    getAppInfo: () => ipcRenderer.invoke('spindle:get-app-info'),
    checkTools: () => ipcRenderer.invoke('spindle:check-tools'),
    inspectYoutube: (url) => ipcRenderer.invoke('spindle:youtube-inspect', url),
    startImport: (params) => ipcRenderer.invoke('spindle:start-import', params),
    cancelImport: (jobId) => ipcRenderer.invoke('spindle:cancel-import', jobId),
    onImportDiscovered: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('spindle:import-discovered', handler);
        return () => ipcRenderer.removeListener('spindle:import-discovered', handler);
    },
    onImportProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('spindle:import-progress', handler);
        return () => ipcRenderer.removeListener('spindle:import-progress', handler);
    },
    onTrackReady: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('spindle:track-ready', handler);
        return () => ipcRenderer.removeListener('spindle:track-ready', handler);
    },
    onImportCompleted: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('spindle:import-completed', handler);
        return () => ipcRenderer.removeListener('spindle:import-completed', handler);
    },
    onImportError: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('spindle:import-error', handler);
        return () => ipcRenderer.removeListener('spindle:import-error', handler);
    },
    openMusicFolder: (subPath) => ipcRenderer.invoke('spindle:open-music-folder', subPath),
    renamePlaylistFolder: (params) => ipcRenderer.invoke('spindle:rename-playlist-folder', params),
    deletePlaylistFolder: (folderName) => ipcRenderer.invoke('spindle:delete-playlist-folder', folderName),
    checkForUpdates: () => ipcRenderer.invoke('spindle:check-for-updates'),
    openExternalUrl: (url) => ipcRenderer.invoke('spindle:open-external-url', url),
    getAppVersion: () => ipcRenderer.invoke('spindle:get-app-version'),
    onUpdateAvailable: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('spindle:update-available', handler);
        return () => ipcRenderer.removeListener('spindle:update-available', handler);
    },
    minimizeWindow: () => ipcRenderer.invoke('spindle:window-minimize'),
    maximizeWindow: () => ipcRenderer.invoke('spindle:window-maximize'),
    closeWindow: () => ipcRenderer.invoke('spindle:window-close'),
    isWindowMaximized: () => ipcRenderer.invoke('spindle:window-is-maximized'),
    onWindowMaximized: (callback) => {
        const handler = (_event, isMax) => callback(isMax);
        ipcRenderer.on('spindle:window-maximized-change', handler);
        return () => ipcRenderer.removeListener('spindle:window-maximized-change', handler);
    },
    saveThemePreference: (theme) => ipcRenderer.invoke('spindle:save-theme-preference', theme)
});
