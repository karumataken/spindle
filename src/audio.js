import { AppState, getCurrentTrack } from './state.js';

export class SoundEngine {
    constructor(htmlAudioElement) {
        this.ctx = null;
        this.masterGain = null;
        this.crackleGain = null;
        this.synthInterval = null;
        this.stepCounter = 0;
        this.htmlAudio = htmlAudioElement || document.getElementById('html5-audio');

        this.onTimeUpdate = null;
        this.onLoadedMetadata = null;
        this.onEnded = null;
        this.onAudioError = null;

        this.lastLiftTime = 0;
        this.lastDropTime = 0;

        this.pendingStartTime = 0;
        this._suppressNativeEvents = false;

        if (this.htmlAudio) {
            this.bindAudioEvents();
        }
    }

    setAudioElement(el) {
        if (this.htmlAudio === el && el?._spindleBound) return;
        this.htmlAudio = el;
        this.bindAudioEvents();
    }

    bindAudioEvents() {
        if (!this.htmlAudio || this.htmlAudio._spindleBound) return;
        this.htmlAudio._spindleBound = true;

        this.htmlAudio.addEventListener('timeupdate', () => {
            const track = getCurrentTrack();
            if (track && !track.isSynth && !AppState.isSeeking) {
                AppState.currentTime = this.htmlAudio.currentTime;
                if (this.htmlAudio.duration && !isNaN(this.htmlAudio.duration)) {
                    AppState.duration = this.htmlAudio.duration;
                }
                if (this.onTimeUpdate) this.onTimeUpdate();
            }
        });

        const applyPendingSeek = () => {
            if (this.pendingStartTime > 0 && this.htmlAudio && !isNaN(this.htmlAudio.duration)) {
                try {
                    this.htmlAudio.currentTime = Math.min(this.pendingStartTime, this.htmlAudio.duration);
                } catch (_) {}
                this.pendingStartTime = 0;
            }
        };

        this.htmlAudio.addEventListener('loadedmetadata', () => {
            const track = getCurrentTrack();
            if (track && !track.isSynth && this.htmlAudio.duration && !isNaN(this.htmlAudio.duration)) {
                track.duration = this.htmlAudio.duration;
                AppState.duration = this.htmlAudio.duration;
                applyPendingSeek();
                if (this.onLoadedMetadata) this.onLoadedMetadata();
            }
        });

        this.htmlAudio.addEventListener('canplay', applyPendingSeek);

        this.htmlAudio.addEventListener('ended', () => {
            if (this.onEnded) this.onEnded();
        });

        this.htmlAudio.addEventListener('error', () => {
            if (this._suppressNativeEvents) return;
            const track = getCurrentTrack();
            if (track && !track.isSynth && AppState.hasActiveSession && this.htmlAudio.getAttribute('src')) {
                const mediaErr = this.htmlAudio.error;
                console.error('[SoundEngine] Media element error:', mediaErr?.code, mediaErr?.message, track.url);
                if (this.onAudioError) this.onAudioError(track, mediaErr);
            }
        });
    }

    initContext() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = AppState.isMuted ? 0 : AppState.volume;
            this.masterGain.connect(this.ctx.destination);
            this.setupVinylCrackle();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
    }

    setupVinylCrackle() {
        const bufferSize = 2 * this.ctx.sampleRate;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            let sample = (Math.random() * 2 - 1) * 0.012;
            if (Math.random() < 0.0012) {
                sample += (Math.random() * 2 - 1) * 0.35;
            }
            output[i] = sample;
        }

        const whiteNoise = this.ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        whiteNoise.loop = true;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1900;
        filter.Q.value = 0.9;

        this.crackleGain = this.ctx.createGain();
        this.crackleGain.gain.value = 0;

        whiteNoise.connect(filter);
        filter.connect(this.crackleGain);
        this.crackleGain.connect(this.masterGain);
        whiteNoise.start(0);
    }

    updateCrackleLevel() {
        if (!this.crackleGain || !this.ctx) return;
        const shouldCrackle = AppState.playbackState === 'PLAYING' && AppState.crackleEnabled;
        this.crackleGain.gain.setTargetAtTime(shouldCrackle ? 0.25 : 0, this.ctx.currentTime, 0.15);
    }

    setVolume(val) {
        AppState.volume = val;
        if (this.htmlAudio) {
            this.htmlAudio.muted = Boolean(AppState.isMuted);
            this.htmlAudio.volume = AppState.isMuted ? 0 : val;
        }
        if (this.masterGain && this.ctx) {
            this.masterGain.gain.setTargetAtTime(AppState.isMuted ? 0 : val, this.ctx.currentTime, 0.05);
        }
    }

    playTrack(track, startTime = 0) {
        if (!track) return;
        this.initContext();
        this.stopAllAudioOnly();

        if (track.isSynth) {
            if (this.htmlAudio) {
                this._suppressNativeEvents = true;
                this.htmlAudio.pause();
                this._suppressNativeEvents = false;
            }
            AppState.currentTime = startTime;
            AppState.duration = track.duration;
            this.startSynthSequencer(track.synthPreset);
        } else {
            if (!track.url) {
                console.error('[SoundEngine] Track is missing playable URL:', track);
                if (this.onAudioError) this.onAudioError(track, new Error('Missing audio URL'));
                return;
            }
            if (this.htmlAudio) {
                this._suppressNativeEvents = true;
                const srcChanged = this.htmlAudio.src !== track.url;
                if (srcChanged) {
                    this.htmlAudio.src = track.url;
                    this.pendingStartTime = startTime;
                } else {
                    try {
                        this.htmlAudio.currentTime = startTime;
                    } catch (_) {}
                    this.pendingStartTime = 0;
                }
                this.htmlAudio.muted = Boolean(AppState.isMuted);
                this.htmlAudio.volume = AppState.isMuted ? 0 : AppState.volume;
                this._suppressNativeEvents = false;

                const playPromise = this.htmlAudio.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch((err) => {
                        // Ignore AbortError caused by rapid track switching
                        if (err && err.name === 'AbortError') return;
                        console.error('[SoundEngine] Audio play() failed:', err, track.url);
                        if (this.onAudioError) this.onAudioError(track, err);
                    });
                }
            }
        }
        this.updateCrackleLevel();
    }

    pauseAudio(playLiftSound = true) {
        const track = getCurrentTrack();
        if (!track) return;
        if (playLiftSound) {
            this.playNeedleLiftSound();
        }
        if (track.isSynth) {
            this.stopSynthSequencer();
        } else if (this.htmlAudio) {
            this._suppressNativeEvents = true;
            this.htmlAudio.pause();
            this._suppressNativeEvents = false;
        }
        this.updateCrackleLevel();
    }

    stopAllAudioOnly(playLiftSound = false) {
        if (playLiftSound) {
            this.playNeedleLiftSound();
        }
        this.stopSynthSequencer();
        if (this.htmlAudio) {
            this._suppressNativeEvents = true;
            this.htmlAudio.pause();
            this._suppressNativeEvents = false;
        }
        this.updateCrackleLevel();
    }

    seek(seconds) {
        const track = getCurrentTrack();
        if (!track) return;
        const bounded = Math.max(0, Math.min(seconds, AppState.duration || seconds));
        AppState.currentTime = bounded;
        if (!track.isSynth && this.htmlAudio) {
            try {
                if (this.htmlAudio.readyState >= 1) {
                    this.htmlAudio.currentTime = bounded;
                    this.pendingStartTime = 0;
                } else {
                    this.pendingStartTime = bounded;
                }
            } catch (err) {
                console.warn('Seek error:', err);
                this.pendingStartTime = bounded;
            }
        }
    }

    // Distinct procedural needle lift sound (damped cantilever pop + micro friction release)
    playNeedleLiftSound() {
        this.initContext();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        if (now - this.lastLiftTime < 0.15) return;
        this.lastLiftTime = now;

        // 1. Damped cartridge pop (stylus snapping free from vinyl groove wall)
        const popOsc = this.ctx.createOscillator();
        const popGain = this.ctx.createGain();
        popOsc.type = 'sine';
        popOsc.frequency.setValueAtTime(145 + Math.random() * 20, now);
        popOsc.frequency.exponentialRampToValueAtTime(50, now + 0.05);

        popGain.gain.setValueAtTime(0.001, now);
        popGain.gain.linearRampToValueAtTime(0.24, now + 0.004);
        popGain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

        popOsc.connect(popGain);
        popGain.connect(this.masterGain);
        popOsc.start(now);
        popOsc.stop(now + 0.06);

        // 2. High-frequency micro-friction scrape (diamond dragging out of rotating groove)
        const sampleRate = this.ctx.sampleRate;
        const bufferSize = Math.floor(sampleRate * 0.045);
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.35));
        }
        const noiseSource = this.ctx.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        const bandpass = this.ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(2900, now);
        bandpass.frequency.linearRampToValueAtTime(4500, now + 0.04);
        bandpass.Q.value = 2.4;

        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.20, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

        noiseSource.connect(bandpass);
        bandpass.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        noiseSource.start(now);

        // 3. Low-end mechanical release thud
        const thudOsc = this.ctx.createOscillator();
        const thudGain = this.ctx.createGain();
        thudOsc.type = 'triangle';
        thudOsc.frequency.setValueAtTime(80, now);
        thudOsc.frequency.exponentialRampToValueAtTime(38, now + 0.06);

        thudGain.gain.setValueAtTime(0.001, now);
        thudGain.gain.linearRampToValueAtTime(0.15, now + 0.005);
        thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

        thudOsc.connect(thudGain);
        thudGain.connect(this.masterGain);
        thudOsc.start(now);
        thudOsc.stop(now + 0.065);
    }

    // Distinct procedural needle drop sound (soft touchdown thud + vinyl seating crackle)
    playNeedleDropSound() {
        this.initContext();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        if (now - this.lastDropTime < 0.15) return;
        this.lastDropTime = now;

        // 1. Soft touchdown thud as diamond stylus meets vinyl surface
        const dropOsc = this.ctx.createOscillator();
        const dropGain = this.ctx.createGain();
        dropOsc.type = 'sine';
        dropOsc.frequency.setValueAtTime(115 + Math.random() * 15, now);
        dropOsc.frequency.exponentialRampToValueAtTime(45, now + 0.07);

        dropGain.gain.setValueAtTime(0.001, now);
        dropGain.gain.linearRampToValueAtTime(0.26, now + 0.005);
        dropGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

        dropOsc.connect(dropGain);
        dropGain.connect(this.masterGain);
        dropOsc.start(now);
        dropOsc.stop(now + 0.075);

        // 2. Diamond groove seating crackle burst
        const sampleRate = this.ctx.sampleRate;
        const bufferSize = Math.floor(sampleRate * 0.075);
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            let s = (Math.random() * 2 - 1) * 0.16;
            if (i < bufferSize * 0.25 && Math.random() < 0.12) {
                s += (Math.random() * 2 - 1) * 0.75;
            }
            data[i] = s * (1 - i / bufferSize);
        }
        const noiseSource = this.ctx.createBufferSource();
        noiseSource.buffer = noiseBuffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1800;
        filter.Q.value = 1.3;

        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.18, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);

        noiseSource.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        noiseSource.start(now);
    }

    startSynthSequencer(preset) {
        this.stopSynthSequencer();
        const stepMs = 450;

        const triggerStep = () => {
            if (AppState.playbackState !== 'PLAYING') return;
            this.playSynthStep(preset, this.stepCounter);
            this.stepCounter++;
        };

        triggerStep();
        this.synthInterval = setInterval(triggerStep, stepMs);
    }

    stopSynthSequencer() {
        if (this.synthInterval) {
            clearInterval(this.synthInterval);
            this.synthInterval = null;
        }
    }

    playSynthStep(preset, step) {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;

        const chords = {
            lofi_jazz: [
                [261.63, 329.63, 392.00, 493.88],
                [220.00, 261.63, 329.63, 392.00],
                [293.66, 349.23, 440.00, 523.25],
                [196.00, 246.94, 293.66, 349.23]
            ],
            ambient_waltz: [
                [293.66, 369.99, 440.00, 554.37],
                [246.94, 329.63, 392.00, 493.88],
                [329.63, 392.00, 493.88, 587.33],
                [220.00, 277.18, 329.63, 392.00]
            ],
            zen_pluck: [
                [261.63, 293.66, 329.63, 392.00, 440.00, 523.25],
                [196.00, 220.00, 261.63, 293.66, 329.63, 392.00]
            ],
            warm_synth: [
                [174.61, 220.00, 261.63, 329.63],
                [164.81, 196.00, 246.94, 293.66],
                [146.83, 174.61, 220.00, 261.63],
                [130.81, 164.81, 196.00, 246.94]
            ]
        };

        const set = chords[preset] || chords.lofi_jazz;
        const chordIdx = Math.floor(step / 8) % set.length;
        const currentChord = set[chordIdx];

        if (step % 8 === 0) {
            currentChord.forEach((freq, idx) => {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = preset === 'warm_synth' ? 'sawtooth' : 'sine';
                osc.frequency.value = freq;

                const lp = this.ctx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 950;

                gain.gain.setValueAtTime(0.001, now);
                gain.gain.linearRampToValueAtTime(0.055 / (idx * 0.35 + 1), now + 0.12);
                gain.gain.exponentialRampToValueAtTime(0.0008, now + 3.2);

                osc.connect(lp);
                lp.connect(gain);
                gain.connect(this.masterGain);

                osc.start(now);
                osc.stop(now + 3.3);
            });
        }

        if (step % 2 === 0 || Math.random() > 0.45) {
            const noteFreq = currentChord[step % currentChord.length] * (step % 4 === 0 ? 2 : 1);
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'triangle';
            osc.frequency.value = noteFreq;

            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.04, now + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.9);

            osc.connect(gain);
            gain.connect(this.masterGain);

            osc.start(now);
            osc.stop(now + 0.95);
        }

        if (step % 4 === 0) {
            const bassOsc = this.ctx.createOscillator();
            const bassGain = this.ctx.createGain();
            bassOsc.type = 'sine';
            bassOsc.frequency.value = currentChord[0] / 2;

            bassGain.gain.setValueAtTime(0.001, now);
            bassGain.gain.linearRampToValueAtTime(0.09, now + 0.04);
            bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

            bassOsc.connect(bassGain);
            bassGain.connect(this.masterGain);

            bassOsc.start(now);
            bassOsc.stop(now + 0.75);
        }
    }
}

export const audioEngine = new SoundEngine();
