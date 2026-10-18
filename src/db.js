export class LocalLibraryDB {
    constructor() {
        this.dbName = 'SpindleMusicPlayerDB';
        this.dbVersion = 2;
        this.schemaVersion = 2;
        this.db = null;
        this.onStorageError = null;
    }

    _reportError(context, err) {
        console.error(`[SpindleDB] ${context}:`, err);
        if (this.onStorageError && err) {
            this.onStorageError(context, err);
        }
    }

    async init() {
        return new Promise((resolve) => {
            let req;
            try {
                req = indexedDB.open(this.dbName, this.dbVersion);
            } catch (err) {
                this._reportError('Failed to open IndexedDB', err);
                resolve(false);
                return;
            }

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('audioFiles')) {
                    db.createObjectStore('audioFiles', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('appState')) {
                    db.createObjectStore('appState', { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(true);
            };
            req.onerror = () => {
                this._reportError('Database open error', req.error);
                resolve(false);
            };
        });
    }

    async saveAudioBlob(id, blob) {
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('audioFiles', 'readwrite');
                tx.objectStore('audioFiles').put({ id, blob, updatedAt: Date.now() });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => {
                    this._reportError(`Failed to save audio blob (${id})`, tx.error);
                    resolve(false);
                };
                tx.onabort = () => {
                    this._reportError(`Aborted saving audio blob (${id})`, tx.error);
                    resolve(false);
                };
            } catch (err) {
                this._reportError(`Exception saving audio blob (${id})`, err);
                resolve(false);
            }
        });
    }

    async getAudioBlob(id) {
        if (!this.db) return null;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('audioFiles', 'readonly');
                const req = tx.objectStore('audioFiles').get(id);
                req.onsuccess = () => resolve(req.result ? req.result.blob : null);
                req.onerror = () => {
                    this._reportError(`Failed to read audio blob (${id})`, req.error);
                    resolve(null);
                };
            } catch (err) {
                this._reportError(`Exception reading audio blob (${id})`, err);
                resolve(null);
            }
        });
    }

    async deleteAudioBlob(id) {
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('audioFiles', 'readwrite');
                tx.objectStore('audioFiles').delete(id);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => {
                    this._reportError(`Failed to delete audio blob (${id})`, tx.error);
                    resolve(false);
                };
            } catch (err) {
                this._reportError(`Exception deleting audio blob (${id})`, err);
                resolve(false);
            }
        });
    }

    async cleanupOrphanedBlobs(validTrackIds = []) {
        if (!this.db) return 0;
        const validSet = new Set(validTrackIds);
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('audioFiles', 'readwrite');
                const store = tx.objectStore('audioFiles');
                const keysReq = store.getAllKeys();
                let removed = 0;

                keysReq.onsuccess = () => {
                    const keys = keysReq.result || [];
                    for (const key of keys) {
                        if (!validSet.has(key)) {
                            store.delete(key);
                            removed++;
                        }
                    }
                };
                tx.oncomplete = () => resolve(removed);
                tx.onerror = () => resolve(0);
            } catch (_) {
                resolve(0);
            }
        });
    }

    async saveMetadata(tracksMeta, playlists) {
        if (!this.db) return false;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('appState', 'readwrite');
                const store = tx.objectStore('appState');
                const serializableTracks = {};
                Object.values(tracksMeta || {}).forEach(t => {
                    if (!t || !t.id) return;
                    const copy = { ...t };
                    delete copy.url;
                    serializableTracks[t.id] = copy;
                });
                store.put({
                    key: 'library',
                    schemaVersion: this.schemaVersion,
                    updatedAt: Date.now(),
                    tracks: serializableTracks,
                    playlists: Array.isArray(playlists) ? playlists : []
                });
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => {
                    this._reportError('Failed to save library metadata', tx.error);
                    resolve(false);
                };
                tx.onabort = () => {
                    this._reportError('Aborted saving library metadata', tx.error);
                    resolve(false);
                };
            } catch (err) {
                this._reportError('Exception saving library metadata', err);
                resolve(false);
            }
        });
    }

    async loadMetadata() {
        if (!this.db) return null;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('appState', 'readonly');
                const req = tx.objectStore('appState').get('library');
                req.onsuccess = () => {
                    const record = req.result;
                    if (!record) {
                        resolve(null);
                        return;
                    }
                    // Normalize v1 -> v2 schema if needed
                    const tracks = record.tracks && typeof record.tracks === 'object' ? record.tracks : {};
                    const playlists = Array.isArray(record.playlists) ? record.playlists : [];
                    resolve({
                        schemaVersion: record.schemaVersion || 1,
                        tracks,
                        playlists
                    });
                };
                req.onerror = () => {
                    this._reportError('Failed to load library metadata', req.error);
                    resolve(null);
                };
            } catch (err) {
                this._reportError('Exception loading library metadata', err);
                resolve(null);
            }
        });
    }
}

export const storageDB = new LocalLibraryDB();
