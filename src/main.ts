import { Channel, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, Window as TauriWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import Webamp from "webamp";
// webamp 2.3.1 ships the Butterchurn runtime as a public export but omits the
// matching declaration file from its package. The class has Webamp's API.
// @ts-expect-error Missing upstream webamp/butterchurn declaration artifact.
import WebampWithButterchurn from "webamp/butterchurn";
import "./styles.css";

type PlaybackState = "disconnected" | "connecting" | "loading" | "ready" | "playing" | "paused" | "ended" | "error";
type MediaCallback = (...args: unknown[]) => void;
type AppUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

interface PlayerStatus {
  state: PlaybackState;
  device_name: string;
  message: string;
  track_title: string | null;
  artist: string | null;
  track_uri: string | null;
  duration_ms: number | null;
  position_ms: number | null;
  track_sequence: number;
  advance_sequence: number;
}

interface SpotifySearchTrack {
  uri: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
}

interface SpotifyPlaylistSummary {
  uri: string;
  name: string;
  owner: string;
  track_count: number;
  is_public: boolean;
  is_collaborative: boolean;
}

interface PlaylistLoadProgress {
  added: number;
  total: number;
  remaining: number;
  skipped: number;
}

interface PlaylistInputTrack {
  url: string;
  defaultName: string;
  metaData?: {
    artist: string;
    title: string;
    album?: string;
  };
  duration: number;
}

interface VisualizerFrame {
  sequence: number;
  samples: number[];
}

interface SkinMuseumSkin {
  md5: string;
  filename: string;
  download_url: string;
  screenshot_url: string;
  nsfw: boolean;
  average_color: string | null;
}

interface InstalledSkin {
  md5: string;
  name: string;
  url: string;
  screenshotUrl: string;
}

const disconnectedStatus: PlayerStatus = {
  state: "disconnected",
  device_name: "Winampfy Desktop",
  message: "Press Play to connect Spotify Premium",
  track_title: null,
  artist: null,
  track_uri: null,
  duration_ms: null,
  position_ms: null,
  track_sequence: 0,
  advance_sequence: 0,
};

const PLAYLIST_STORAGE_KEY = "winampfy.playlist.v1";
const INSTALLED_SKINS_STORAGE_KEY = "winampfy.skins.v1";
const ACTIVE_SKIN_STORAGE_KEY = "winampfy.active-skin.v1";
const ONBOARDING_STORAGE_KEY = "winampfy.onboarding.v1";
const WINDOWS_STORAGE_KEY = "winampfy.windows.v1";
const GEOMETRY_STORAGE_KEY = "winampfy.geometry.v1";
const PLAYLIST_SIZE_STORAGE_KEY = "winampfy.playlist-size.v1";
const SKIN_MUSEUM_API = "https://skins.webamp.org/graphql";
const SKIN_PAGE_SIZE = 24;
const WINAMP_LOGO_URL = new URL("../src-tauri/icons/winamp-logo.png", import.meta.url).href;

// The app is laid out like classic Winamp: the player, the equalizer and the
// playlist editor are separate OS windows that can be shown, hidden and
// dragged around individually, plus one utility window that hosts the larger
// dialogs (search, playlist browser, skin explorer, onboarding, updates).
type WindowRole = "main" | "equalizer" | "playlist" | "milkdrop" | "dialogs";
const windowRole: WindowRole = (() => {
  const role = new URLSearchParams(window.location.search).get("role");
  return role === "equalizer" || role === "playlist" || role === "milkdrop" || role === "dialogs"
    ? role
    : "main";
})();
document.documentElement.dataset.windowRole = windowRole;
const isPanelWindow = windowRole !== "dialogs";

interface WindowsState {
  equalizer: boolean;
  playlist: boolean;
  milkdrop: boolean;
}

function loadWindowsState(): WindowsState {
  try {
    const value = JSON.parse(localStorage.getItem(WINDOWS_STORAGE_KEY) ?? "{}") as Partial<WindowsState>;
    return {
      equalizer: typeof value.equalizer === "boolean" ? value.equalizer : true,
      playlist: typeof value.playlist === "boolean" ? value.playlist : true,
      milkdrop: typeof value.milkdrop === "boolean" ? value.milkdrop : true,
    };
  } catch {
    return { equalizer: true, playlist: true, milkdrop: true };
  }
}

function saveWindowsState(state: WindowsState) {
  localStorage.setItem(WINDOWS_STORAGE_KEY, JSON.stringify(state));
  syncNativePanelButtons(state);
  void invoke("set_panel_visibility_state", {
    equalizer: state.equalizer,
    playlist: state.playlist,
    milkdrop: state.milkdrop,
  }).catch(() => {});
  void emit("winampfy:windows-state", state);
}

function syncNativePanelButtons(state = loadWindowsState()) {
  document.querySelector("#main-window #equalizer-button")?.classList.toggle("selected", state.equalizer);
  document.querySelector("#main-window #playlist-button")?.classList.toggle("selected", state.playlist);
}

const initialWindowsState = loadWindowsState();
void invoke("set_panel_visibility_state", {
  equalizer: initialWindowsState.equalizer,
  playlist: initialWindowsState.playlist,
  milkdrop: initialWindowsState.milkdrop,
}).catch(() => {});

function loadPlaylistWindowSize(): [number, number] | null {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYLIST_SIZE_STORAGE_KEY) ?? "null") as unknown;
    return Array.isArray(value)
      && value.length === 2
      && value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)
      ? [Math.round(value[0] as number), Math.round(value[1] as number)]
      : null;
  } catch {
    return null;
  }
}

const PANEL_SELECTOR: Record<Exclude<WindowRole, "dialogs">, string> = {
  main: "#main-window",
  equalizer: "#equalizer-window",
  playlist: "#playlist-window",
  milkdrop: ".gen-window",
};

let latestStatus = disconnectedStatus;
let webamp: Webamp | null = null;
let lastMetadataKey = "";
let activeTrackUrl = "spotify:current";
// Webamp instantiates the custom media class without arguments, so the
// leader flag has to be decided before the Webamp instance is created.
let mediaIsLeader = false;

class LibrespotMedia {
  private listeners = new Map<string, Set<MediaCallback>>();
  private context = new AudioContext();
  private analyser = this.context.createAnalyser();
  private currentUrl = "spotify:current";
  private pollTimer: number;
  private pollInFlight = false;
  private lastAdvanceSequence = 0;
  private pendingReconcile = false;
  private loadGeneration = 0;
  private loadingTrack = false;
  private desiredVolume: number | null = null;
  private appliedVolume = 72;
  private volumeUpdateInFlight = false;
  private volumeSyncTimer: number | null = null;
  private visualizerTimer: number | null = null;
  private visualizerPollInFlight = false;
  private lastVisualizerSequence = 0;
  private visualizerFrames: Float32Array[] = [];
  private visualizerFrameOffset = 0;
  private visualizerNode: ScriptProcessorNode | null = null;
  private visualizerMute: GainNode | null = null;
  // Only the playlist window owns the queue UI; every other window must poll
  // for display only. Advancing (or reconciling the selection) from more than
  // one window would race and double-load tracks.
  private readonly leader = mediaIsLeader;

  constructor() {
    this.analyser.fftSize = windowRole === "milkdrop" ? 2048 : 256;
    if (windowRole === "main" || windowRole === "milkdrop") this.startVisualizerBridge();
    this.pollTimer = window.setInterval(() => this.poll(), 300);
    void this.poll();
  }

  private startVisualizerBridge() {
    // librespot owns the audible output. A muted ScriptProcessor graph feeds a
    // downsampled PCM copy into Webamp's classic spectrum analyser and Milkdrop.
    const processor = this.context.createScriptProcessor(2048, 0, 2);
    const mute = this.context.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      if (latestStatus.state === "playing" || latestStatus.state === "loading") {
        let outputOffset = 0;
        while (outputOffset < output.length && this.visualizerFrames.length > 0) {
          const frame = this.visualizerFrames[0];
          const available = frame.length - this.visualizerFrameOffset;
          const count = Math.min(output.length - outputOffset, available);
          output.set(frame.subarray(this.visualizerFrameOffset, this.visualizerFrameOffset + count), outputOffset);
          outputOffset += count;
          this.visualizerFrameOffset += count;
          if (this.visualizerFrameOffset >= frame.length) {
            this.visualizerFrames.shift();
            this.visualizerFrameOffset = 0;
          }
        }
      }
      for (let channel = 1; channel < event.outputBuffer.numberOfChannels; channel += 1) {
        event.outputBuffer.getChannelData(channel).set(output);
      }
    };
    processor.connect(this.analyser);
    this.analyser.connect(mute);
    mute.connect(this.context.destination);
    this.visualizerNode = processor;
    this.visualizerMute = mute;
    this.visualizerTimer = window.setInterval(() => void this.pollVisualizerFrame(), 25);
    window.addEventListener("focus", this.resumeAudioContext);
    document.addEventListener("pointerdown", this.resumeAudioContext, { capture: true });
    void this.context.resume();
  }

  private resumeAudioContext = () => {
    if (this.context.state === "suspended") void this.context.resume();
  };

  private async pollVisualizerFrame() {
    if (this.visualizerPollInFlight) return;
    this.visualizerPollInFlight = true;
    try {
      const frame = await invoke<VisualizerFrame>("player_visualizer_frame");
      if (frame.sequence === this.lastVisualizerSequence || frame.samples.length === 0) return;
      this.lastVisualizerSequence = frame.sequence;
      this.visualizerFrames.push(Float32Array.from(frame.samples));
      // A temporarily throttled window should resume from live audio, not
      // churn through seconds of stale visualization frames.
      if (this.visualizerFrames.length > 4) {
        this.visualizerFrames.splice(0, this.visualizerFrames.length - 4);
        this.visualizerFrameOffset = 0;
      }
    } catch {
    } finally {
      this.visualizerPollInFlight = false;
    }
  }

  private emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((callback) => callback(...args));
  }

  private async poll() {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const previous = latestStatus;
      latestStatus = await invoke<PlayerStatus>("player_status");

      if (latestStatus.state === "playing" && previous.state !== "playing") {
        this.emit("playing");
      }
      // EndOfTrack can be followed by Stopped faster than this status poll.
      // The monotonic sequence makes the advance durable even if that
      // transient `ended` state is never observed. Unavailable tracks use the
      // same signal so one bad playlist entry cannot stop the whole queue.
      if (this.leader && latestStatus.advance_sequence !== this.lastAdvanceSequence) {
        this.lastAdvanceSequence = latestStatus.advance_sequence;
        this.pendingReconcile = true;
      }
      if (this.leader && this.pendingReconcile) {
        // While our timers were suspended the Rust guardian may have advanced
        // through several tracks on its own. Re-align webamp with what the
        // backend is actually playing before letting it advance blindly.
        const result = reconcileWebampTrack();
        if (result !== "retry") {
          this.pendingReconcile = false;
          if (result === "self") this.emit("ended");
        }
      } else if (
        this.leader
        && !this.loadingTrack
        && (latestStatus.state === "playing"
          || latestStatus.state === "loading"
          || latestStatus.state === "paused")
      ) {
        // Manual transport commands are issued by the separate player
        // window, so they do not increment Webamp's end-of-track sequence.
        // Still move Playlist Editor's current row to the backend track.
        reconcileWebampTrack();
      }
      this.emit("timeupdate");
      syncWebampMetadata(latestStatus);
    } catch {
    } finally {
      this.pollInFlight = false;
    }
  }

  on(event: string, callback: MediaCallback) {
    const callbacks = this.listeners.get(event) ?? new Set<MediaCallback>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
  }

  // Stall and session-drop recovery live in the Rust guardian on purpose:
  // these JavaScript timers are throttled whenever the webview is occluded,
  // which previously turned every recovery path here into a misfire that
  // restarted tracks from stale positions.

  timeElapsed() {
    if (this.loadingTrack) return 0;
    return (latestStatus.position_ms ?? 0) / 1000;
  }

  duration() {
    if (this.loadingTrack) return 0;
    return (latestStatus.duration_ms ?? 0) / 1000;
  }

  async play() {
    if (latestStatus.state === "disconnected" || latestStatus.state === "error") {
      latestStatus = await invoke<PlayerStatus>("spotify_login");
    }
    if (this.currentUrl !== "spotify:current" && latestStatus.track_title == null) {
      await invoke("player_load_uri", { uri: this.currentUrl, autoPlay: true });
    } else {
      await invoke("player_play");
    }
  }

  pause() {
    void invoke("player_pause");
  }

  stop() {
    void invoke("player_stop");
  }

  seekToPercentComplete(percent: number) {
    const positionMs = Math.round((latestStatus.duration_ms ?? 0) * (percent / 100));
    void invoke("player_seek", { positionMs });
  }

  private async waitForTrackChange(trackSequence: number, loadGeneration: number) {
    const deadline = Date.now() + 12_000;
    while (this.loadGeneration === loadGeneration && Date.now() < deadline) {
      if (latestStatus.track_sequence !== trackSequence && latestStatus.duration_ms != null) {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return false;
  }

  async loadFromUrl(url: string, autoPlay: boolean) {
    const loadGeneration = ++this.loadGeneration;
    this.currentUrl = url;
    activeTrackUrl = url;
    lastMetadataKey = "";
    this.loadingTrack = true;
    this.emit("waiting");
    void invoke("player_set_current", { uri: url }).catch(() => {});
    let waiting = true;
    const releaseWaiting = () => {
      if (!waiting) return;
      waiting = false;
      this.emit("stopWaiting");
    };
    try {
      if (url !== "spotify:current") {
        if (
          latestStatus.track_uri === url
          && (latestStatus.state === "playing" || latestStatus.state === "loading")
        ) {
          // The backend is already streaming exactly this track: the Rust
          // guardian advanced the queue while our timers were throttled.
          // Adopt the live stream instead of reloading and restarting it.
          releaseWaiting();
          this.loadingTrack = false;
          this.emit("fileLoaded");
          this.emit("timeupdate");
          return;
        }

        if (latestStatus.state === "disconnected" || latestStatus.state === "error") {
          latestStatus = await invoke<PlayerStatus>("spotify_login");
        }

        const trackSequence = latestStatus.track_sequence;
        latestStatus = {
          ...latestStatus,
          state: "loading",
          message: "Parça yükleniyor",
          track_title: null,
          artist: null,
          track_uri: null,
          duration_ms: null,
          position_ms: 0,
        };
        this.emit("timeupdate");
        await invoke("player_load_uri", { uri: url, autoPlay });
        // The command has been accepted. Metadata can arrive later, but the
        // rest of Winamp must remain interactive while we wait for it.
        releaseWaiting();

        const loaded = await this.waitForTrackChange(trackSequence, loadGeneration);
        if (this.loadGeneration !== loadGeneration) return;
        if (!loaded) {
          // The load command was accepted but the backend never delivered any
          // metadata. This usually means the Spotify session is dead (all
          // commands silently no-op). Reconnect and retry once before giving up
          // on this track.
          console.warn("Winampfy timed out while waiting for track metadata", url);
          try {
            latestStatus = await invoke<PlayerStatus>("spotify_login");
          } catch (error) {
            console.warn("Winampfy reconnection after load timeout failed", error);
          }
          if (this.loadGeneration !== loadGeneration) return;
          const retryTrackSequence = latestStatus.track_sequence;
          await invoke("player_load_uri", { uri: url, autoPlay }).catch((error) => {
            console.warn("Winampfy retry track load failed", error);
          });
          const retried = await this.waitForTrackChange(retryTrackSequence, loadGeneration);
          if (this.loadGeneration !== loadGeneration) return;
          if (!retried) return;
        }
      }
      releaseWaiting();
      this.loadingTrack = false;
      this.emit("fileLoaded");
      this.emit("timeupdate");
      if (autoPlay && url === "spotify:current") await this.play();
    } catch (error) {
      console.error("Winampfy could not load the requested track", error);
    } finally {
      if (this.loadGeneration === loadGeneration) {
        this.loadingTrack = false;
        this.emit("timeupdate");
      }
      // Webamp blocks all controls between waiting/stopWaiting. Always release
      // that lock, including failed, timed-out and superseded load requests.
      releaseWaiting();
    }
  }

  setVolume(volume: number) {
    this.desiredVolume = Math.max(0, Math.min(100, Math.round(volume)));
    if (this.volumeSyncTimer != null) {
      window.clearTimeout(this.volumeSyncTimer);
      this.volumeSyncTimer = null;
    }
    void this.flushVolume();
  }

  private async flushVolume() {
    if (this.volumeUpdateInFlight) return;
    this.volumeUpdateInFlight = true;
    try {
      while (this.desiredVolume != null) {
        const volume = this.desiredVolume;
        this.desiredVolume = null;
        await invoke("player_set_volume", { volume });
        this.appliedVolume = volume;
      }
    } catch (error) {
      console.warn("Winampfy volume update failed", error);
    } finally {
      this.volumeUpdateInFlight = false;
      if (this.desiredVolume != null) {
        void this.flushVolume();
        return;
      }

      // The soft mixer changes immediately above. Spotify Connect only needs
      // the final value, so debounce that slower state synchronization instead
      // of filling librespot's command queue while the knob is being dragged.
      this.volumeSyncTimer = window.setTimeout(() => {
        this.volumeSyncTimer = null;
        void invoke("player_sync_volume", { volume: this.appliedVolume }).catch((error) => {
          console.warn("Spotify volume synchronization failed", error);
        });
      }, 180);
    }
  }

  setBalance(_balance: number) {}
  setPreamp(_value: number) {}
  setEqBand(_band: number, _value: number) {}
  disableEq() {}
  enableEq() {}

  getAnalyser() {
    return this.analyser;
  }

  dispose() {
    window.clearInterval(this.pollTimer);
    if (this.volumeSyncTimer != null) window.clearTimeout(this.volumeSyncTimer);
    if (this.visualizerTimer != null) window.clearInterval(this.visualizerTimer);
    window.removeEventListener("focus", this.resumeAudioContext);
    document.removeEventListener("pointerdown", this.resumeAudioContext, { capture: true });
    this.visualizerNode?.disconnect();
    this.visualizerMute?.disconnect();
    this.listeners.clear();
    void this.context.close();
  }
}

function syncWebampMetadata(status: PlayerStatus) {
  if (!webamp) return;
  const playlistTracks = webamp.getPlaylistTracks();
  const currentTrack = playlistTracks.find((track) => track.url === activeTrackUrl);
  if (!currentTrack) return;
  if (
    windowRole === "playlist"
    && (status.track_uri == null
      || normaliseSpotifyIdentity(currentTrack.url) !== normaliseSpotifyIdentity(status.track_uri))
  ) {
    // A transport change can reach this webview one poll before Webamp moves
    // its selection. Never overwrite the old row with the new song's tags.
    return;
  }

  const title = status.track_title ?? status.message;
  const artist = status.artist ?? (status.state === "ready" ? "Spotify connected" : "Spotify Premium");
  const metadataKey = `${title}|${artist}|${status.duration_ms}`;
  if (metadataKey === lastMetadataKey) return;
  lastMetadataKey = metadataKey;

  webamp.store.dispatch({
    type: "SET_MEDIA_TAGS",
    id: currentTrack.id,
    title,
    artist,
    bitrate: 320,
    sampleRate: 44100,
    numberOfChannels: 2,
  });
  if (status.duration_ms != null) {
    webamp.store.dispatch({
      type: "SET_MEDIA_DURATION",
      id: currentTrack.id,
      duration: status.duration_ms / 1000,
    });
  }
}

// While the webview's JavaScript timers are suspended in the background the
// Rust guardian advances through the queued tracks on its own. When the
// window returns, catch webamp's selection up to whatever the backend is
// actually playing instead of blindly emitting "ended" — that would advance a
// single track from webamp's stale position and audibly jump to the wrong
// song.
//
// Returns "aligned" when webamp now matches the backend, "self" when webamp
// should advance itself (the normal end-of-track flow) and "retry" when the
// backend is momentarily between tracks and the decision should be retried
// on the next poll.
function reconcileWebampTrack(): "aligned" | "self" | "retry" {
  if (!webamp) return "self";
  const backendUri = latestStatus.track_uri;
  if (backendUri == null) return "self";
  const tracks = webamp.getPlaylistTracks();
  const backendIdentity = normaliseSpotifyIdentity(backendUri);
  const backendPosition = tracks.findIndex(
    (track) => normaliseSpotifyIdentity(track.url) === backendIdentity,
  );
  if (backendPosition === -1) return "self";
  const currentId = webamp.store.getState().playlist.currentTrack;
  const currentPosition = currentId == null
    ? -1
    : tracks.findIndex((track) => track.id === currentId);
  if (backendPosition !== currentPosition) {
    if (latestStatus.state === "playing" || latestStatus.state === "loading" || latestStatus.state === "paused") {
      // Select the track the backend is on by id — display positions and ids
      // diverge once tracks have been removed or reordered. The matching
      // loadFromUrl call adopts the live stream instead of restarting it.
      webamp.store.dispatch({
        type: latestStatus.state === "paused" ? "BUFFER_TRACK" : "PLAY_TRACK",
        id: tracks[backendPosition].id,
      });
      return "aligned";
    }
    // The backend just finished this track and the guardian is about to load
    // the next one; deciding now would reload a track that already ended.
    return "retry";
  }
  // Backend and webamp agree (e.g. the guardian merely restarted the current
  // track after a stall). Only let webamp advance when the backend really
  // finished the track.
  return latestStatus.state === "ended" ? "self" : "aligned";
}

// The main window's Webamp instance only has a metadata placeholder. Resolve
// transport actions from the persisted real playlist and load the target in
// librespot directly, so Next does not depend on a hidden playlist webview
// receiving and processing a cross-window event.
async function advanceTransport(command: "next" | "previous", count: number) {
  const tracks = loadSavedPlaylist();
  if (tracks.length === 0) return;

  const step = command === "next" ? count : -count;
  const state = webamp?.store.getState();
  const currentUri = latestStatus.track_uri == null
    ? null
    : normaliseSpotifyIdentity(latestStatus.track_uri);
  const currentIndex = currentUri == null
    ? -1
    : tracks.findIndex((track) => normaliseSpotifyIdentity(track.url) === currentUri);
  let targetIndex: number;
  if (state?.media.shuffle) {
    targetIndex = Math.floor(Math.random() * tracks.length);
    while (targetIndex === currentIndex && tracks.length > 1) {
      targetIndex = Math.floor(Math.random() * tracks.length);
    }
  } else if (state?.media.repeat) {
    targetIndex = (((currentIndex + step) % tracks.length) + tracks.length) % tracks.length;
  } else {
    const origin = currentIndex < 0 ? (step > 0 ? -1 : tracks.length) : currentIndex;
    if ((origin === tracks.length - 1 && step > 0) || (origin === 0 && step < 0)) return;
    targetIndex = Math.max(0, Math.min(tracks.length - 1, origin + step));
  }

  const target = tracks[targetIndex];
  const autoPlay = latestStatus.state === "playing" || latestStatus.state === "loading";
  const previousStatus = latestStatus;
  latestStatus = {
    ...latestStatus,
    state: autoPlay ? "loading" : "paused",
    message: "Parça yükleniyor",
    track_uri: target.url,
    track_title: target.metaData?.title ?? target.defaultName,
    artist: target.metaData?.artist ?? null,
    duration_ms: Math.round(target.duration * 1000),
    position_ms: 0,
  };
  try {
    await invoke("player_set_queue", { uris: tracks.map((track) => track.url) });
    await invoke("player_set_current", { uri: target.url });
    await invoke("player_load_uri", { uri: target.url, autoPlay });
  } catch (error) {
    latestStatus = previousStatus;
    if (previousStatus.track_uri) {
      void invoke("player_set_current", { uri: previousStatus.track_uri }).catch(() => {});
    }
    console.warn("Winampfy could not advance the playlist", error);
  }
}

function normaliseSpotifyIdentity(value: string) {
  const input = value.trim();
  const match = input.match(/^https?:\/\/open\.spotify\.com\/([^/?#]+)\/([^/?#]+)/i);
  return match ? `spotify:${match[1]}:${match[2]}` : input;
}

function loadSavedPlaylist(): PlaylistInputTrack[] {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];

    return value.filter((track): track is PlaylistInputTrack => {
      if (typeof track !== "object" || track == null) return false;
      const candidate = track as Partial<PlaylistInputTrack>;
      return typeof candidate.url === "string"
        && typeof candidate.defaultName === "string"
        && typeof candidate.duration === "number";
    });
  } catch {
    return [];
  }
}

function loadInstalledSkins(): InstalledSkin[] {
  try {
    const value = JSON.parse(localStorage.getItem(INSTALLED_SKINS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((skin): skin is InstalledSkin => {
      if (typeof skin !== "object" || skin == null) return false;
      const candidate = skin as Partial<InstalledSkin>;
      return typeof candidate.md5 === "string"
        && typeof candidate.name === "string"
        && typeof candidate.url === "string"
        && typeof candidate.screenshotUrl === "string";
    });
  } catch {
    return [];
  }
}

const savedPlaylist = loadSavedPlaylist();
let installedSkins = loadInstalledSkins();
const savedActiveSkinUrl = localStorage.getItem(ACTIVE_SKIN_STORAGE_KEY);
const initialSkinUrl = installedSkins.some((skin) => skin.url === savedActiveSkinUrl)
  ? savedActiveSkinUrl
  : null;
const connectionPlaceholder: PlaylistInputTrack = {
  url: "spotify:current",
  defaultName: "Spotify Premium — Press Play to Connect",
  metaData: {
    artist: "Spotify Premium",
    title: "Press Play to Connect",
  },
  duration: 0,
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Application root is missing");

app.innerHTML = `
  <div id="webamp-container" aria-label="Winampfy player"></div>
  <div id="spotify-search-dialog" class="search-dialog" hidden>
    <section class="search-panel" role="dialog" aria-modal="true" aria-labelledby="search-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="search-title">ADD URL // SPOTIFY SEARCH</span>
        <i class="title-rule" aria-hidden="true"></i>
        <button id="search-close" type="button" aria-label="Kapat">×</button>
      </header>
      <form id="spotify-search-form">
        <label for="spotify-search-input">ŞARKI, SANATÇI VEYA SPOTIFY URL</label>
        <div class="search-input-row">
          <input id="spotify-search-input" autocomplete="off" spellcheck="false" />
          <button id="search-submit" type="submit">SEARCH</button>
        </div>
      </form>
      <div id="search-status">Aramak için bir şey yazın.</div>
      <div id="search-results" role="listbox" aria-label="Spotify arama sonuçları"></div>
      <footer>
        <span>Birden fazla parça seçebilirsiniz.</span>
        <button id="search-add" type="button" disabled>ADD SEL</button>
      </footer>
    </section>
  </div>
  <div id="spotify-playlist-dialog" class="search-dialog" hidden>
    <section class="search-panel" role="dialog" aria-modal="true" aria-labelledby="playlist-search-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="playlist-search-title">LOAD LIST // SPOTIFY PLAYLISTS</span>
        <i class="title-rule" aria-hidden="true"></i>
        <button id="playlist-search-fullscreen" class="dialog-fullscreen" type="button" aria-label="Tam ekran" aria-pressed="false">□</button>
        <button id="playlist-search-close" type="button" aria-label="Kapat">×</button>
      </header>
      <form id="spotify-playlist-form">
        <label for="spotify-playlist-input">PLAYLIST ADI VEYA SPOTIFY PLAYLIST URL</label>
        <div class="search-input-row">
          <input id="spotify-playlist-input" autocomplete="off" spellcheck="false" />
          <button id="playlist-search-submit" type="submit">SEARCH</button>
        </div>
      </form>
      <div id="playlist-search-status">Playlistler yükleniyor...</div>
      <div id="playlist-search-results" role="radiogroup" aria-label="Spotify playlist sonuçları"></div>
      <footer>
        <label class="playlist-shuffle">
          <input id="playlist-shuffle" type="checkbox" />
          SHUFFLE BEFORE LOAD
        </label>
        <button id="playlist-load" type="button" disabled>LOAD</button>
      </footer>
    </section>
  </div>
  <div id="skin-explorer-dialog" class="search-dialog skin-explorer-dialog" hidden>
    <section class="search-panel skin-explorer-panel" role="dialog" aria-modal="true" aria-labelledby="skin-explorer-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="skin-explorer-title">EXPLORE SKINS // SKINS.WEBAMP.ORG</span>
        <i class="title-rule" aria-hidden="true"></i>
        <button id="skin-explorer-fullscreen" class="dialog-fullscreen" type="button" aria-label="Tam ekran" aria-pressed="false">□</button>
        <button id="skin-explorer-close" type="button" aria-label="Kapat">×</button>
      </header>
      <form id="skin-search-form">
        <label for="skin-search-input">SEARCH 100,000+ CLASSIC WINAMP SKINS</label>
        <div class="search-input-row">
          <input id="skin-search-input" autocomplete="off" spellcheck="false" />
          <button id="skin-search-submit" type="submit">SEARCH</button>
        </div>
      </form>
      <div id="skin-search-status">Skin Museum yükleniyor...</div>
      <div id="skin-search-results" role="listbox" aria-label="Winamp skin sonuçları"></div>
      <footer class="skin-explorer-footer">
        <span id="skin-source">WINAMP SKIN MUSEUM</span>
        <span id="skin-scroll-state">SCROLL FOR MORE</span>
        <button id="skin-apply" type="button" disabled>DOWNLOAD + APPLY</button>
      </footer>
    </section>
  </div>
  <div id="onboarding-dialog" class="search-dialog onboarding-dialog" hidden>
    <section class="search-panel onboarding-panel" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="onboarding-title">WINAMPFY QUICK START</span>
        <i class="title-rule" aria-hidden="true"></i>
        <button id="onboarding-close" type="button" aria-label="Kapat">×</button>
      </header>
      <div class="onboarding-content">
        <div class="onboarding-step" data-step="0">
          <span class="onboarding-kicker">STEP 1 / 3</span>
          <strong>CONNECT SPOTIFY</strong>
          <p>Press <b>PLAY</b> or open <b>ADD</b>. Complete Spotify login in your browser when it opens. Spotify does not need to stay open afterwards.</p>
          <div class="onboarding-control"><span>▶</span> PLAY TO CONNECT</div>
        </div>
        <div class="onboarding-step" data-step="1" hidden>
          <span class="onboarding-kicker">STEP 2 / 3</span>
          <strong>ADD SONGS</strong>
          <p>In the Playlist Editor press <b>ADD</b>. Search by song or artist, or paste a Spotify track URL. Select one or more results, then press <b>ADD SEL</b>.</p>
          <div class="onboarding-path"><span>ADD</span><i>→</i><span>SEARCH / URL</span><i>→</i><span>ADD SEL</span></div>
        </div>
        <div class="onboarding-step" data-step="2" hidden>
          <span class="onboarding-kicker">STEP 3 / 3</span>
          <strong>LOAD A PLAYLIST</strong>
          <p>Open <b>LIST OPTS → LOAD LIST</b>. Search your playlists or paste a Spotify playlist URL, select one, optionally enable shuffle, and press <b>LOAD</b>.</p>
          <div class="onboarding-path"><span>LIST OPTS</span><i>→</i><span>LOAD LIST</span><i>→</i><span>LOAD</span></div>
        </div>
      </div>
      <div class="onboarding-progress" aria-label="Onboarding ilerlemesi">
        <i data-step="0" data-active="true"></i>
        <i data-step="1"></i>
        <i data-step="2"></i>
      </div>
      <footer>
        <button id="onboarding-back" type="button" disabled>BACK</button>
        <span>AVAILABLE AGAIN FROM ABOUT</span>
        <button id="onboarding-next" type="button">NEXT</button>
      </footer>
    </section>
  </div>
  <div id="update-dialog" class="search-dialog update-dialog" hidden>
    <section class="search-panel update-panel" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="update-title">WINAMPFY UPDATE</span>
        <i class="title-rule" aria-hidden="true"></i>
        <button id="update-close" type="button" aria-label="Kapat">×</button>
      </header>
      <div class="update-content">
        <strong id="update-version"></strong>
        <p id="update-message"></p>
        <pre id="update-notes" hidden></pre>
        <div id="update-progress" hidden><span></span></div>
        <div id="update-status" data-state="idle"></div>
      </div>
      <footer>
        <button id="update-later" type="button">NOT NOW</button>
        <button id="update-install" type="button">UPDATE NOW</button>
      </footer>
    </section>
  </div>
  <div id="about-dialog" class="search-dialog about-dialog" hidden>
    <section class="search-panel about-panel" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="about-title">ABOUT WINAMPFY</span>
        <i class="title-rule" aria-hidden="true"></i>
        <button id="about-close" type="button" aria-label="Kapat">×</button>
      </header>
      <div class="about-content">
        <img src="${WINAMP_LOGO_URL}" alt="" />
        <div class="about-copy">
          <strong>WINAMPFY</strong>
          <span id="about-version">VERSION ...</span>
          <p>OLD-SCHOOL WINAMP LOOK.<br />SPOTIFY UNDER THE HOOD.</p>
          <span class="about-author">by KiPSOFT aka Serkan KOCAMAN</span>
        </div>
      </div>
      <footer>
        <span>POWERED BY WEBAMP + LIBRESPOT</span>
        <div class="about-actions">
          <button id="about-help" type="button">HOW TO USE</button>
          <button id="about-ok" type="button">OK</button>
        </div>
      </footer>
    </section>
  </div>
`;

function bindDialogFullscreen(dialog: HTMLElement, button: HTMLButtonElement) {
  const appWindow = getCurrentWindow();
  let disposed = false;
  const initialFullscreen = appWindow.isFullscreen().catch(() => false);

  const renderState = (fullscreen: boolean) => {
    if (disposed) return;
    dialog.dataset.nativeFullscreen = String(fullscreen);
    button.setAttribute("aria-pressed", String(fullscreen));
    button.setAttribute("aria-label", fullscreen ? "Tam ekrandan çık" : "Tam ekran");
    button.title = fullscreen ? "RESTORE" : "FULL SCREEN";
    button.textContent = fullscreen ? "▣" : "□";
  };

  const syncState = async () => renderState(await appWindow.isFullscreen());
  button.disabled = false;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const fullscreen = await appWindow.isFullscreen();
      await appWindow.setFullscreen(!fullscreen);
      renderState(!fullscreen);
    } catch (error) {
      console.warn("Full screen mode could not be changed", error);
    } finally {
      if (!disposed) button.disabled = false;
    }
  };
  void syncState();

  return () => {
    disposed = true;
    button.onclick = null;
    delete dialog.dataset.nativeFullscreen;
    void initialFullscreen.then(async (wasFullscreen) => {
      try {
        if (await appWindow.isFullscreen() !== wasFullscreen) {
          await appWindow.setFullscreen(wasFullscreen);
        }
      } catch (error) {
        console.warn("Full screen mode could not be restored", error);
      }
    });
  };
}

function openOnboardingDialog(force = false) {
  if (!force && localStorage.getItem(ONBOARDING_STORAGE_KEY) === "complete") return false;

  const dialog = document.querySelector<HTMLElement>("#onboarding-dialog")!;
  const closeButton = document.querySelector<HTMLButtonElement>("#onboarding-close")!;
  const backButton = document.querySelector<HTMLButtonElement>("#onboarding-back")!;
  const nextButton = document.querySelector<HTMLButtonElement>("#onboarding-next")!;
  const steps = [...dialog.querySelectorAll<HTMLElement>(".onboarding-step")];
  const progress = [...dialog.querySelectorAll<HTMLElement>(".onboarding-progress i")];
  let currentStep = 0;

  const render = () => {
    steps.forEach((step, index) => { step.hidden = index !== currentStep; });
    progress.forEach((dot, index) => { dot.dataset.active = String(index === currentStep); });
    backButton.disabled = currentStep === 0;
    nextButton.textContent = currentStep === steps.length - 1 ? "LET'S PLAY" : "NEXT";
  };
  const close = () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "complete");
    dialog.hidden = true;
    closeButton.onclick = null;
    backButton.onclick = null;
    nextButton.onclick = null;
    dialog.onkeydown = null;
    hideDialogsWindow();
  };

  dialog.hidden = false;
  closeButton.onclick = close;
  backButton.onclick = () => {
    currentStep = Math.max(0, currentStep - 1);
    render();
  };
  nextButton.onclick = () => {
    if (currentStep === steps.length - 1) {
      close();
      return;
    }
    currentStep += 1;
    render();
  };
  dialog.onkeydown = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft" && currentStep > 0) {
      currentStep -= 1;
      render();
    }
    if (event.key === "ArrowRight" && currentStep < steps.length - 1) {
      currentStep += 1;
      render();
    }
  };
  render();
  window.setTimeout(() => nextButton.focus(), 0);
  return true;
}

// The app lives in the tray for days thanks to background playback, so a
// launch-only check would never notice a new release. Re-check periodically
// and whenever the user brings the window back. A GitHub release also gets
// its per-platform updater manifest assembled over several minutes while the
// CI matrix finishes; a check during that window legitimately reports "no
// update", which the next scheduled check then corrects.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Closing any dialog hides the shared dialogs window until it is needed again.
function hideDialogsWindow() {
  if (windowRole === "dialogs") void getCurrentWindow().hide();
}

let updateCheckInFlight = false;
let updateDismissedThisSession = false;
let lastUpdateCheckAt = 0;

async function checkForAppUpdate() {
  if (import.meta.env.DEV || updateCheckInFlight || updateDismissedThisSession) return;
  if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
  if (!document.querySelector<HTMLElement>("#onboarding-dialog")!.hidden) {
    window.setTimeout(() => void checkForAppUpdate(), 1000);
    return;
  }
  updateCheckInFlight = true;
  lastUpdateCheckAt = Date.now();
  try {
    const update = await check();
    if (update) showUpdateDialog(update);
  } catch (error) {
    // Update checks should never interrupt music playback. A missing release
    // manifest or an offline connection will simply be retried later.
    console.warn("Winampfy update check failed", error);
  } finally {
    updateCheckInFlight = false;
  }
}

function showUpdateDialog(update: AppUpdate) {
  const dialog = document.querySelector<HTMLElement>("#update-dialog")!;
  const closeButton = document.querySelector<HTMLButtonElement>("#update-close")!;
  const laterButton = document.querySelector<HTMLButtonElement>("#update-later")!;
  const installButton = document.querySelector<HTMLButtonElement>("#update-install")!;
  const version = document.querySelector<HTMLElement>("#update-version")!;
  const message = document.querySelector<HTMLElement>("#update-message")!;
  const notes = document.querySelector<HTMLElement>("#update-notes")!;
  const progress = document.querySelector<HTMLElement>("#update-progress")!;
  const progressBar = progress.querySelector<HTMLElement>("span")!;
  const status = document.querySelector<HTMLElement>("#update-status")!;

  version.textContent = `WINAMPFY ${update.version}`;
  message.textContent = "Yeni sürüm hazır. Şimdi indirip kurmak ister misiniz?";
  notes.textContent = update.body ?? "";
  notes.hidden = notes.textContent.trim().length === 0;
  progress.hidden = true;
  progressBar.style.width = "0%";
  status.textContent = "Güncelleme güvenli bir imzayla doğrulanacaktır.";
  status.dataset.state = "idle";
  dialog.hidden = false;
  if (windowRole === "dialogs") void getCurrentWindow().show();

  const dismiss = () => {
    dialog.hidden = true;
    updateDismissedThisSession = true;
    void update.close();
    hideDialogsWindow();
  };
  closeButton.onclick = dismiss;
  laterButton.onclick = dismiss;
  installButton.onclick = async () => {
    closeButton.disabled = true;
    laterButton.disabled = true;
    installButton.disabled = true;
    progress.hidden = false;
    status.dataset.state = "loading";
    status.textContent = "İNDİRİLİYOR: 0%";

    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        } else if (event.event === "Finished") {
          progressBar.style.width = "100%";
          status.textContent = "KURULDU — YENİDEN BAŞLATILIYOR";
          return;
        }

        if (total > 0) {
          const percent = Math.min(100, Math.round((downloaded / total) * 100));
          progressBar.style.width = `${percent}%`;
          status.textContent = `İNDİRİLİYOR: ${percent}%`;
        } else {
          status.textContent = "İNDİRİLİYOR...";
        }
      });
      await relaunch();
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = `GÜNCELLEME HATASI: ${String(error)}`;
      closeButton.disabled = false;
      laterButton.disabled = false;
      installButton.disabled = false;
      installButton.textContent = "RETRY";
    }
  };
}

async function openAboutDialog() {
  const dialog = document.querySelector<HTMLElement>("#about-dialog")!;
  const closeButton = document.querySelector<HTMLButtonElement>("#about-close")!;
  const helpButton = document.querySelector<HTMLButtonElement>("#about-help")!;
  const okButton = document.querySelector<HTMLButtonElement>("#about-ok")!;
  const version = document.querySelector<HTMLElement>("#about-version")!;

  dialog.hidden = false;
  version.textContent = "VERSION ...";

  const close = () => {
    dialog.hidden = true;
    closeButton.onclick = null;
    helpButton.onclick = null;
    okButton.onclick = null;
    dialog.onkeydown = null;
    hideDialogsWindow();
  };
  closeButton.onclick = close;
  okButton.onclick = close;
  helpButton.onclick = () => {
    close();
    openOnboardingDialog(true);
  };
  dialog.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  window.setTimeout(() => okButton.focus(), 0);

  try {
    version.textContent = `VERSION ${await getVersion()}`;
  } catch (error) {
    version.textContent = "VERSION UNKNOWN";
    console.warn("Winampfy version could not be read", error);
  }
}

function skinMenuEntries() {
  return installedSkins.map((skin) => ({ url: skin.url, name: skin.name }));
}

function syncInstalledSkinMenu() {
  webamp?.store.dispatch({ type: "SET_AVAILABLE_SKINS", skins: skinMenuEntries() });
}

async function fetchSkinMuseumPage(query: string, offset: number) {
  const first = SKIN_PAGE_SIZE + 1;
  const document = query
    ? `query SearchSkins($first: Int!, $offset: Int!, $query: String!) {
        search_classic_skins(first: $first, offset: $offset, query: $query) {
          md5 filename download_url screenshot_url nsfw average_color
        }
      }`
    : `query BrowseSkins($first: Int!, $offset: Int!) {
        skins(first: $first, offset: $offset, sort: MUSEUM) {
          count
          nodes {
            __typename
            ... on ClassicSkin {
              md5 filename download_url screenshot_url nsfw average_color
            }
          }
        }
      }`;
  const response = await fetch(SKIN_MUSEUM_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: document,
      variables: query ? { first, offset, query } : { first, offset },
    }),
  });
  if (!response.ok) throw new Error(`Skin Museum HTTP ${response.status}`);

  const payload = await response.json() as {
    data?: {
      search_classic_skins?: SkinMuseumSkin[];
      skins?: { count: number; nodes: Array<SkinMuseumSkin & { __typename?: string }> };
    };
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? "GraphQL error").join(", "));
  }

  const rawSkins = query
    ? payload.data?.search_classic_skins ?? []
    : (payload.data?.skins?.nodes ?? []).filter((skin) => skin.__typename === "ClassicSkin");
  const safeSkins = rawSkins.filter((skin) => !skin.nsfw && skin.md5 && skin.download_url);
  return {
    skins: safeSkins.slice(0, SKIN_PAGE_SIZE),
    hasNext: rawSkins.length > SKIN_PAGE_SIZE,
    total: query ? null : payload.data?.skins?.count ?? null,
  };
}

async function downloadAndApplySkin(skin: SkinMuseumSkin) {
  const response = await fetch(skin.download_url);
  if (!response.ok) throw new Error(`Skin download HTTP ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    // The dialogs window has no Webamp instance; there the skin is only
    // recorded and every panel window reloads with it.
    if (webamp) {
      webamp.setSkinFromUrl(objectUrl);
      await webamp.skinIsLoaded();
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const installed: InstalledSkin = {
    md5: skin.md5,
    name: skin.filename.replace(/\.wsz$/i, ""),
    url: skin.download_url,
    screenshotUrl: skin.screenshot_url,
  };
  installedSkins = [installed, ...installedSkins.filter((item) => item.md5 !== installed.md5)];
  localStorage.setItem(INSTALLED_SKINS_STORAGE_KEY, JSON.stringify(installedSkins));
  localStorage.setItem(ACTIVE_SKIN_STORAGE_KEY, installed.url);
  syncInstalledSkinMenu();
  await emit("winampfy:skin-changed", { source: windowRole });
}

function openSkinExplorerDialog() {
  const dialog = document.querySelector<HTMLElement>("#skin-explorer-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#skin-search-form")!;
  const input = document.querySelector<HTMLInputElement>("#skin-search-input")!;
  const closeButton = document.querySelector<HTMLButtonElement>("#skin-explorer-close")!;
  const fullscreenButton = document.querySelector<HTMLButtonElement>("#skin-explorer-fullscreen")!;
  const submitButton = document.querySelector<HTMLButtonElement>("#skin-search-submit")!;
  const applyButton = document.querySelector<HTMLButtonElement>("#skin-apply")!;
  const scrollState = document.querySelector<HTMLElement>("#skin-scroll-state")!;
  const status = document.querySelector<HTMLElement>("#skin-search-status")!;
  const resultsElement = document.querySelector<HTMLElement>("#skin-search-results")!;

  let query = "";
  let offset = 0;
  let results: SkinMuseumSkin[] = [];
  let selectedIndex = -1;
  let hasNext = true;
  let isLoading = false;
  let knownTotal: number | null = null;
  let requestId = 0;
  const restoreFullscreen = bindDialogFullscreen(dialog, fullscreenButton);
  const resizeObserver = new ResizeObserver(() => maybeLoadMore());

  const close = () => {
    requestId += 1;
    restoreFullscreen();
    resizeObserver.disconnect();
    dialog.hidden = true;
    form.onsubmit = null;
    closeButton.onclick = null;
    applyButton.onclick = null;
    resultsElement.onclick = null;
    resultsElement.ondblclick = null;
    resultsElement.onscroll = null;
    dialog.onkeydown = null;
    hideDialogsWindow();
  };

  const appendResults = (skins: SkinMuseumSkin[], startIndex: number) => {
    const fragment = document.createDocumentFragment();
    skins.forEach((skin, localIndex) => {
      const index = startIndex + localIndex;
      const card = document.createElement("button");
      const installed = installedSkins.some((item) => item.md5 === skin.md5);
      card.type = "button";
      card.className = "skin-result";
      card.dataset.index = String(index);
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", String(index === selectedIndex));

      const image = document.createElement("img");
      image.src = skin.screenshot_url;
      image.alt = "";
      image.loading = "lazy";
      const name = document.createElement("span");
      name.textContent = skin.filename.replace(/\.wsz$/i, "");
      card.append(image, name);
      if (installed) {
        const badge = document.createElement("small");
        badge.textContent = "INSTALLED";
        card.append(badge);
      }
      fragment.append(card);
    });
    resultsElement.append(fragment);
    applyButton.disabled = selectedIndex < 0;
  };

  const loadMore = async (reset = false) => {
    if (!reset && (isLoading || !hasNext)) return;
    if (reset) {
      requestId += 1;
      offset = 0;
      results = [];
      selectedIndex = -1;
      hasNext = true;
      knownTotal = null;
      resultsElement.replaceChildren();
      resultsElement.scrollTop = 0;
    }

    const currentRequest = requestId;
    isLoading = true;
    submitButton.disabled = true;
    applyButton.disabled = true;
    scrollState.textContent = "LOADING MORE...";
    status.textContent = results.length === 0
      ? "SKIN MUSEUM YÜKLENİYOR..."
      : `${results.length} SKINS LOADED • LOADING MORE...`;
    status.dataset.state = "loading";

    try {
      const page = await fetchSkinMuseumPage(query, offset);
      if (currentRequest !== requestId) return;
      const existingIds = new Set(results.map((skin) => skin.md5));
      const nextSkins = page.skins.filter((skin) => !existingIds.has(skin.md5));
      const startIndex = results.length;
      results.push(...nextSkins);
      offset += SKIN_PAGE_SIZE;
      hasNext = page.hasNext;
      if (page.total != null) knownTotal = page.total;
      if (selectedIndex < 0 && results.length > 0) selectedIndex = 0;
      appendResults(nextSkins, startIndex);
      const total = knownTotal == null ? "" : ` / ${knownTotal.toLocaleString()}`;
      status.textContent = results.length > 0
        ? `${results.length}${total} SKINS LOADED • SELECT AND APPLY`
        : "SKIN BULUNAMADI";
      status.dataset.state = results.length > 0 ? "success" : "error";
      scrollState.textContent = hasNext ? "SCROLL FOR MORE" : "END OF RESULTS";
    } catch (error) {
      if (currentRequest !== requestId) return;
      status.textContent = `SKIN MUSEUM HATASI: ${String(error)}`;
      status.dataset.state = "error";
      scrollState.textContent = "LOAD ERROR — SEARCH TO RETRY";
      hasNext = false;
    } finally {
      if (currentRequest !== requestId) return;
      isLoading = false;
      submitButton.disabled = false;
      applyButton.disabled = selectedIndex < 0;
      window.setTimeout(maybeLoadMore, 0);
    }
  };

  function maybeLoadMore() {
    if (isLoading || !hasNext || dialog.hidden) return;
    const remaining = resultsElement.scrollHeight
      - resultsElement.scrollTop
      - resultsElement.clientHeight;
    if (remaining <= 220) void loadMore();
  }

  const applySelected = async () => {
    const skin = results[selectedIndex];
    if (!skin) return;
    applyButton.disabled = true;
    closeButton.disabled = true;
    status.textContent = `${skin.filename} İNDİRİLİYOR VE UYGULANIYOR...`;
    status.dataset.state = "loading";
    try {
      await downloadAndApplySkin(skin);
      close();
    } catch (error) {
      status.textContent = `SKIN HATASI: ${String(error)}`;
      status.dataset.state = "error";
      applyButton.disabled = false;
      closeButton.disabled = false;
    }
  };

  dialog.hidden = false;
  closeButton.disabled = false;
  input.value = "";
  closeButton.onclick = close;
  dialog.onkeydown = (event) => {
    if (event.key === "Escape") close();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    query = input.value.trim();
    void loadMore(true);
  };
  resultsElement.onscroll = maybeLoadMore;
  resultsElement.onclick = (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".skin-result");
    if (!card) return;
    resultsElement.querySelector<HTMLElement>('.skin-result[aria-selected="true"]')
      ?.setAttribute("aria-selected", "false");
    selectedIndex = Number(card.dataset.index);
    card.setAttribute("aria-selected", "true");
    applyButton.disabled = false;
  };
  resultsElement.ondblclick = (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".skin-result");
    if (!card) return;
    selectedIndex = Number(card.dataset.index);
    void applySelected();
  };
  applyButton.onclick = () => void applySelected();
  resizeObserver.observe(resultsElement);
  window.setTimeout(() => input.focus(), 0);
  void loadMore(true);
}

// Each window renders exactly one Webamp panel; the other two are omitted so
// they start closed inside that instance. The real equalizer and playlist
// live in their own native windows.
const savedPlaylistGeometry = loadGeometries().playlist;
const savedPlaylistWindowSize = loadPlaylistWindowSize();
const playlistExtraWidth = savedPlaylistWindowSize?.[0]
  ?? (savedPlaylistGeometry ? Math.max(0, Math.round((savedPlaylistGeometry.w - 275) / 25)) : 11);
const playlistExtraHeight = savedPlaylistWindowSize?.[1]
  ?? (savedPlaylistGeometry ? Math.max(0, Math.round((savedPlaylistGeometry.h - 116) / 29)) : 6);
const panelWindowLayouts = {
  main: { main: { position: { left: 0, top: 0 } } },
  equalizer: { equalizer: { position: { left: 0, top: 0 } } },
  playlist: {
    playlist: {
      position: { left: 0, top: 0 },
      size: { extraWidth: playlistExtraWidth, extraHeight: playlistExtraHeight },
    },
  },
  milkdrop: {
    milkdrop: {
      position: { left: 0, top: 0 },
      size: { extraWidth: 11, extraHeight: 10 },
    },
  },
} as const;

mediaIsLeader = windowRole === "playlist";

const WebampClass: typeof Webamp = windowRole === "milkdrop"
  ? WebampWithButterchurn as typeof Webamp
  : Webamp;
webamp = new WebampClass({
  __customMediaClass: LibrespotMedia,
  initialSkin: initialSkinUrl ? { url: initialSkinUrl } : undefined,
  availableSkins: windowRole === "main" ? skinMenuEntries() : undefined,
  initialTracks: windowRole === "playlist"
    ? (savedPlaylist.length > 0 ? savedPlaylist : [connectionPlaceholder])
    : windowRole === "main" || windowRole === "milkdrop"
      ? [connectionPlaceholder]
      : [],
  windowLayout: windowRole === "equalizer"
    ? panelWindowLayouts.equalizer
    : windowRole === "playlist"
      ? panelWindowLayouts.playlist
      : windowRole === "milkdrop"
        ? panelWindowLayouts.milkdrop
        : panelWindowLayouts.main,
  enableHotkeys: windowRole === "main",
  enableMediaSession: false,
  handleTrackDropEvent: windowRole === "playlist"
    ? (event) => {
        const text = event.dataTransfer.getData("text/plain").trim();
        return text ? [{ url: text, defaultName: text, duration: 0 }] : null;
      }
    : undefined,
});

if (windowRole === "playlist") {
  void invoke("player_set_queue", {
    uris: savedPlaylist.map((track) => track.url),
  }).catch(() => {});
}

function toPlaylistTrack(track: SpotifySearchTrack): PlaylistInputTrack {
  return {
    url: track.uri,
    defaultName: `${track.artist} - ${track.title}`,
    metaData: {
      artist: track.artist,
      title: track.title,
      album: track.album,
    },
    duration: track.duration_ms / 1000,
  };
}

function formatDuration(durationMs: number) {
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function openSpotifySearchDialog(): Promise<PlaylistInputTrack[] | null> {
  const dialog = document.querySelector<HTMLElement>("#spotify-search-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#spotify-search-form")!;
  const input = document.querySelector<HTMLInputElement>("#spotify-search-input")!;
  const closeButton = document.querySelector<HTMLButtonElement>("#search-close")!;
  const submitButton = document.querySelector<HTMLButtonElement>("#search-submit")!;
  const addButton = document.querySelector<HTMLButtonElement>("#search-add")!;
  const status = document.querySelector<HTMLElement>("#search-status")!;
  const resultsElement = document.querySelector<HTMLElement>("#search-results")!;

  dialog.hidden = false;
  input.value = "";
  status.textContent = "Aramak için bir şey yazın.";
  status.dataset.state = "idle";
  resultsElement.replaceChildren();
  addButton.disabled = true;
  window.setTimeout(() => input.focus(), 0);

  return new Promise((resolve) => {
    let results: SpotifySearchTrack[] = [];

    const finish = (tracks: PlaylistInputTrack[] | null) => {
      dialog.hidden = true;
      form.onsubmit = null;
      closeButton.onclick = null;
      addButton.onclick = null;
      dialog.onkeydown = null;
      hideDialogsWindow();
      resolve(tracks);
    };

    closeButton.onclick = () => finish(null);
    dialog.onkeydown = (event) => {
      if (event.key === "Escape") finish(null);
    };

    form.onsubmit = async (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) {
        status.textContent = "Önce bir arama metni yazın.";
        status.dataset.state = "error";
        return;
      }

      if (query.startsWith("spotify:") || /^https?:\/\/open\.spotify\.com\//.test(query)) {
        finish([{ url: query, defaultName: query, duration: 0 }]);
        return;
      }

      submitButton.disabled = true;
      addButton.disabled = true;
      input.disabled = true;
      status.textContent = "Spotify aranıyor...";
      status.dataset.state = "loading";
      resultsElement.replaceChildren();

      try {
        if (latestStatus.state === "disconnected" || latestStatus.state === "error") {
          status.textContent = "Spotify hesabına bağlanılıyor...";
          latestStatus = await invoke<PlayerStatus>("spotify_login");
          status.textContent = "Spotify aranıyor...";
        }

        results = await invoke<SpotifySearchTrack[]>("spotify_search", { query, limit: 10 });
        if (results.length === 0) {
          status.textContent = "Sonuç bulunamadı.";
          status.dataset.state = "error";
          return;
        }

        const fragment = document.createDocumentFragment();
        results.forEach((track, index) => {
          const row = document.createElement("label");
          row.className = "search-result";
          row.innerHTML = `
            <input type="checkbox" value="${index}" ${index === 0 ? "checked" : ""} />
            <span class="result-number">${index + 1}.</span>
            <span class="result-copy">
              <strong></strong>
              <small></small>
            </span>
            <time>${formatDuration(track.duration_ms)}</time>
          `;
          row.querySelector("strong")!.textContent = track.title;
          row.querySelector("small")!.textContent = `${track.artist} — ${track.album}`;
          fragment.append(row);
        });
        resultsElement.append(fragment);
        status.textContent = `${results.length} sonuç bulundu.`;
        status.dataset.state = "success";
        addButton.disabled = false;
      } catch (error) {
        status.textContent = `Hata: ${String(error)}`;
        status.dataset.state = "error";
      } finally {
        submitButton.disabled = false;
        input.disabled = false;
        input.focus();
      }
    };

    resultsElement.onchange = () => {
      addButton.disabled = resultsElement.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]:checked',
      ).length === 0;
    };

    addButton.onclick = () => {
      const selected = [...resultsElement.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]:checked',
      )].map((checkbox) => results[Number(checkbox.value)]).filter(Boolean);
      if (selected.length === 0) return;
      finish(selected.map(toPlaylistTrack));
    };
  });
}

function isSpotifyPlaylistInput(value: string) {
  return value.startsWith("spotify:playlist:")
    || /^https?:\/\/open\.spotify\.com\/playlist\//.test(value);
}

function shuffleTracks(tracks: PlaylistInputTrack[]) {
  const shuffled = [...tracks];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function openSpotifyPlaylistDialog(): Promise<PlaylistInputTrack[] | null> {
  const dialog = document.querySelector<HTMLElement>("#spotify-playlist-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#spotify-playlist-form")!;
  const input = document.querySelector<HTMLInputElement>("#spotify-playlist-input")!;
  const closeButton = document.querySelector<HTMLButtonElement>("#playlist-search-close")!;
  const fullscreenButton = document.querySelector<HTMLButtonElement>("#playlist-search-fullscreen")!;
  const submitButton = document.querySelector<HTMLButtonElement>("#playlist-search-submit")!;
  const loadButton = document.querySelector<HTMLButtonElement>("#playlist-load")!;
  const shuffle = document.querySelector<HTMLInputElement>("#playlist-shuffle")!;
  const status = document.querySelector<HTMLElement>("#playlist-search-status")!;
  const resultsElement = document.querySelector<HTMLElement>("#playlist-search-results")!;

  dialog.hidden = false;
  input.value = "";
  shuffle.checked = false;
  status.textContent = "Playlistler yükleniyor...";
  status.dataset.state = "loading";
  resultsElement.replaceChildren();
  loadButton.disabled = true;
  const restoreFullscreen = bindDialogFullscreen(dialog, fullscreenButton);
  window.setTimeout(() => input.focus(), 0);

  return new Promise((resolve) => {
    let results: SpotifyPlaylistSummary[] = [];
    let urlSearchTimer: number | null = null;
    let searchRequestId = 0;

    const finish = (tracks: PlaylistInputTrack[] | null) => {
      if (urlSearchTimer != null) window.clearTimeout(urlSearchTimer);
      restoreFullscreen();
      dialog.hidden = true;
      form.onsubmit = null;
      input.oninput = null;
      closeButton.onclick = null;
      loadButton.onclick = null;
      resultsElement.onchange = null;
      resultsElement.ondblclick = null;
      dialog.onkeydown = null;
      hideDialogsWindow();
      resolve(tracks);
    };

    const ensureSpotifySession = async () => {
      if (latestStatus.state === "disconnected" || latestStatus.state === "error") {
        status.textContent = "Spotify hesabına bağlanılıyor...";
        latestStatus = await invoke<PlayerStatus>("spotify_login");
      }
    };

    const renderPlaylists = (playlists: SpotifyPlaylistSummary[]) => {
      resultsElement.replaceChildren();
      const fragment = document.createDocumentFragment();
      playlists.forEach((playlist, index) => {
        const isLikedSongs = playlist.uri.endsWith(":collection");
        const visibility = playlist.is_collaborative
          ? "COLLABORATIVE"
          : playlist.is_public ? "PUBLIC" : "PRIVATE";
        const row = document.createElement("label");
        row.className = "search-result playlist-result";
        row.innerHTML = `
          <input type="radio" name="spotify-playlist" value="${index}" ${index === 0 ? "checked" : ""} />
          <span class="result-number">${index + 1}.</span>
          <span class="result-copy">
            <strong></strong>
            <small></small>
          </span>
          <time>${isLikedSongs ? "LIKED" : `${playlist.track_count} TRACKS`}</time>
        `;
        row.querySelector("strong")!.textContent = playlist.name;
        row.querySelector("small")!.textContent = isLikedSongs
          ? `SAVED — ${playlist.owner || "Spotify"}`
          : `${visibility} — ${playlist.owner || "Spotify"}`;
        fragment.append(row);
      });
      resultsElement.append(fragment);
      loadButton.disabled = playlists.length === 0;
    };

    const searchPlaylists = async (query: string) => {
      const requestId = ++searchRequestId;
      submitButton.disabled = true;
      loadButton.disabled = true;
      input.disabled = true;
      status.textContent = "Spotify playlistleri aranıyor...";
      status.dataset.state = "loading";
      resultsElement.replaceChildren();

      try {
        let nextResults: SpotifyPlaylistSummary[];
        if (isSpotifyPlaylistInput(query)) {
          nextResults = [{
            uri: query,
            name: "Spotify Playlist URL",
            owner: "Direct link",
            track_count: 0,
            is_public: true,
            is_collaborative: false,
          }];
        } else {
          await ensureSpotifySession();
          nextResults = await invoke<SpotifyPlaylistSummary[]>("spotify_playlists", {
            query: query || null,
            limit: 100,
          });
        }

        if (requestId !== searchRequestId) return;
        results = nextResults;
        renderPlaylists(results);
        status.textContent = results.length === 0
          ? "Eşleşen playlist bulunamadı."
          : `${results.length} playlist bulundu. Bir playlist seçin.`;
        status.dataset.state = results.length === 0 ? "error" : "success";
      } catch (error) {
        if (requestId !== searchRequestId) return;
        status.textContent = `Hata: ${String(error)}`;
        status.dataset.state = "error";
      } finally {
        if (requestId !== searchRequestId) return;
        submitButton.disabled = false;
        input.disabled = false;
        input.focus();
      }
    };

    const loadSelectedPlaylist = async () => {
      const selected = resultsElement.querySelector<HTMLInputElement>(
        'input[name="spotify-playlist"]:checked',
      );
      const playlist = selected ? results[Number(selected.value)] : null;
      if (!playlist) return;

      submitButton.disabled = true;
      loadButton.disabled = true;
      input.disabled = true;
      status.textContent = `${playlist.name} içindeki şarkılar yükleniyor...`;
      status.dataset.state = "loading";

      try {
        await ensureSpotifySession();
        const onProgress = new Channel<PlaylistLoadProgress>();
        onProgress.onmessage = (progress) => {
          const skipped = progress.skipped > 0 ? ` • ATLANAN: ${progress.skipped}` : "";
          status.textContent = `EKLENEN: ${progress.added} / ${progress.total} • KALAN: ${progress.remaining}${skipped}`;
          status.dataset.state = "loading";
        };
        const tracks = await invoke<SpotifySearchTrack[]>("spotify_playlist_tracks", {
          uri: playlist.uri,
          onProgress,
        });
        const playlistTracks = tracks.map(toPlaylistTrack);
        finish(shuffle.checked ? shuffleTracks(playlistTracks) : playlistTracks);
      } catch (error) {
        status.textContent = `Hata: ${String(error)}`;
        status.dataset.state = "error";
        submitButton.disabled = false;
        loadButton.disabled = false;
        input.disabled = false;
      }
    };

    closeButton.onclick = () => finish(null);
    dialog.onkeydown = (event) => {
      if (event.key === "Escape") finish(null);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      void searchPlaylists(input.value.trim());
    };
    input.oninput = () => {
      if (urlSearchTimer != null) window.clearTimeout(urlSearchTimer);
      const query = input.value.trim();
      if (!isSpotifyPlaylistInput(query)) return;
      urlSearchTimer = window.setTimeout(() => void searchPlaylists(query), 120);
    };
    resultsElement.onchange = () => {
      loadButton.disabled = !resultsElement.querySelector('input[name="spotify-playlist"]:checked');
    };
    resultsElement.ondblclick = (event) => {
      if ((event.target as HTMLElement).closest(".playlist-result")) {
        void loadSelectedPlaylist();
      }
    };
    loadButton.onclick = () => void loadSelectedPlaylist();

    void searchPlaylists("");
  });
}

function replacePlaylistTracks(tracks: PlaylistInputTrack[]) {
  if (!webamp || tracks.length === 0) return;
  const ids = webamp.getPlaylistTracks().map((track) => track.id);
  if (ids.length > 0) {
    webamp.store.dispatch({ type: "REMOVE_TRACKS", ids });
  }
  webamp.appendTracks(tracks);
  webamp.setCurrentTrack(0);
}

function removeConnectionPlaceholder() {
  if (!webamp) return;
  const placeholder = webamp.getPlaylistTracks().find((track) => track.url === "spotify:current");
  if (placeholder) {
    webamp.store.dispatch({ type: "REMOVE_TRACKS", ids: [placeholder.id] });
  }
}

// --- Multi-window management -------------------------------------------------
//
// The Winamp panels and Milkdrop are separate native windows. They remember whether
// they are open and where they were placed; dragging the player carries the
// other open panels along, and all large dialogs live in a fourth utility
// window.

type PanelRole = "main" | "equalizer" | "playlist" | "milkdrop";
type AuxiliaryPanelRole = Exclude<PanelRole, "main">;

type NativeWindow = TauriWindow | WebviewWindow;

async function nativePanelWindow(role: PanelRole): Promise<NativeWindow | null> {
  if (role === windowRole) return getCurrentWindow();
  return WebviewWindow.getByLabel(role);
}

function showPanelWindow(role: AuxiliaryPanelRole) {
  saveWindowsState({ ...loadWindowsState(), [role]: true });
  void nativePanelWindow(role).then(async (win) => {
    if (!win) return;
    await win.show();
    await win.setFocus();
  });
}

function hidePanelWindow(role: AuxiliaryPanelRole) {
  saveWindowsState({ ...loadWindowsState(), [role]: false });
  void nativePanelWindow(role).then((win) => win?.hide());
  if (role === windowRole) void getCurrentWindow().hide();
}

function togglePanelWindow(role: AuxiliaryPanelRole) {
  // The saved preference can intentionally differ from native visibility
  // while the whole group is minimized or during startup restoration. Always
  // toggle what is actually on screen so one click reliably opens the panel.
  void nativePanelWindow(role).then(async (win) => {
    if (!win) return;
    if (await win.isVisible()) {
      hidePanelWindow(role);
    } else {
      showPanelWindow(role);
    }
  });
}

async function openDialogWindow(kind: "search" | "playlists" | "skins" | "about") {
  if (windowRole === "dialogs") {
    void emit("winampfy:open-dialog", { kind });
    return;
  }
  const dialogs = await WebviewWindow.getByLabel("dialogs");
  await dialogs?.show();
  await dialogs?.setFocus();
  await emit("winampfy:open-dialog", { kind });
}

interface PanelGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const geometries = new Map<PanelRole, PanelGeometry>();
let geometryPersistTimer: number | null = null;

function loadGeometries(): Partial<Record<PanelRole, PanelGeometry>> {
  try {
    return JSON.parse(localStorage.getItem(GEOMETRY_STORAGE_KEY) ?? "{}") as Partial<
      Record<PanelRole, PanelGeometry>
    >;
  } catch {
    return {};
  }
}

function persistGeometries() {
  localStorage.setItem(GEOMETRY_STORAGE_KEY, JSON.stringify({
    ...loadGeometries(),
    ...Object.fromEntries(geometries),
  }));
}

function persistGeometriesSoon() {
  if (geometryPersistTimer != null) window.clearTimeout(geometryPersistTimer);
  geometryPersistTimer = window.setTimeout(() => {
    geometryPersistTimer = null;
    persistGeometries();
  }, 600);
}

window.addEventListener("beforeunload", persistGeometries);

function trackOwnGeometry() {
  if (!isPanelWindow) return;
  const panel = document.querySelector<HTMLElement>(
    PANEL_SELECTOR[windowRole as Exclude<WindowRole, "dialogs">],
  );
  if (!panel) return;

  const appWindow = getCurrentWindow();
  const readGeometry = async (): Promise<PanelGeometry | null> => {
    try {
      const [scale, position] = await Promise.all([appWindow.scaleFactor(), appWindow.outerPosition()]);
      const rect = panel.getBoundingClientRect();
      return { x: position.x / scale, y: position.y / scale, w: rect.width, h: rect.height };
    } catch {
      return null;
    }
  };

  const publish = (geo: PanelGeometry, broadcast: boolean) => {
    geometries.set(windowRole as PanelRole, geo);
    if (broadcast) void emit("winampfy:geometry", { role: windowRole, ...geo });
    persistGeometriesSoon();
  };

  void readGeometry().then((geo) => {
    if (geo) publish(geo, true);
  });

  // Shade mode, the playlist resize grip and skin changes all resize the
  // panel; the native window must follow or the panel gets clipped.
  new ResizeObserver(() => {
    void readGeometry().then((geo) => {
      if (!geo) return;
      void appWindow.setSize(new LogicalSize(geo.w, geo.h));
      publish(geo, true);
    });
  }).observe(panel);

  // Every panel publishes its own position; the Rust side carries the open
  // sibling panels whenever the player window moves, and moving an equalizer
  // or playlist window never drags the others along.
  void appWindow.onMoved(async ({ payload }) => {
    const scale = await appWindow.scaleFactor();
    const size = geometries.get(windowRole as PanelRole);
    publish({
      x: payload.x / scale,
      y: payload.y / scale,
      w: size?.w ?? panel.getBoundingClientRect().width,
      h: size?.h ?? panel.getBoundingClientRect().height,
    }, true);
  });
}

void listen<{ role: PanelRole } & PanelGeometry>("winampfy:geometry", (event) => {
  const { role, x, y, w, h } = event.payload;
  if (role === windowRole) return;
  geometries.set(role, { x, y, w, h });
  persistGeometriesSoon();
});

// Place the equalizer and playlist windows at their remembered spot, or in
// the classic stacked layout right below the player on first run.
async function restorePanelWindows() {
  if (windowRole !== "main") return;
  const appWindow = getCurrentWindow();
  const saved = loadGeometries();
  try {
    const scale = await appWindow.scaleFactor();
    let own: { x: number; y: number };
    if (saved.main) {
      own = { x: saved.main.x, y: saved.main.y };
      await appWindow.setPosition(new LogicalPosition(own.x, own.y));
    } else {
      const position = await appWindow.outerPosition();
      own = { x: position.x / scale, y: position.y / scale };
    }
    const fallbacks: Record<AuxiliaryPanelRole, PanelGeometry> = {
      equalizer: { x: own.x, y: own.y + 116, w: 275, h: 116 },
      playlist: {
        x: own.x,
        y: own.y + 232,
        w: 275 + playlistExtraWidth * 25,
        h: 116 + playlistExtraHeight * 29,
      },
      milkdrop: { x: own.x + 275, y: own.y, w: 550, h: 406 },
    };
    const windows = loadWindowsState();
    for (const role of ["equalizer", "playlist", "milkdrop"] as const) {
      const geo = saved[role] ?? fallbacks[role];
      geometries.set(role, geo);
      const target = await nativePanelWindow(role);
      if (!target) continue;
      await target.setPosition(new LogicalPosition(geo.x, geo.y));
      if (windows[role]) await target.show();
    }
  } catch (error) {
    console.warn("Winampfy could not restore the panel windows", error);
  }
}

// Shuffle/repeat only exist in each window's own Webamp instance, but the
// playlist window picks the next track. Broadcast every toggle so all windows
// agree; the flag keeps the synced dispatches from re-broadcasting.
let syncingTransportModes = false;

const originalDispatch = webamp.store.dispatch;
webamp.store.dispatch = ((action: Parameters<typeof originalDispatch>[0]) => {
  if (typeof action === "object" && action != null && "type" in action) {
    if (action.type === "TOGGLE_SHUFFLE" || action.type === "TOGGLE_REPEAT") {
      const shuffle = action.type === "TOGGLE_SHUFFLE" ? !webamp!.isShuffleEnabled() : webamp!.isShuffleEnabled();
      const repeat = action.type === "TOGGLE_REPEAT" ? !webamp!.isRepeatEnabled() : webamp!.isRepeatEnabled();
      if (!syncingTransportModes) {
        void invoke(action.type === "TOGGLE_SHUFFLE" ? "player_set_shuffle" : "player_set_repeat", {
          enabled: action.type === "TOGGLE_SHUFFLE" ? shuffle : repeat,
        });
        void emit("winampfy:transport-modes", { shuffle, repeat });
      }
    }
    // The player's EQ/PL buttons and the panels' own close buttons manage the
    // native panel windows; the corresponding panels are closed inside this
    // Webamp instance and must never be toggled open here.
    const windowAction = action as { type: string; windowId?: string };
    if (windowRole === "main" && windowAction.type === "TOGGLE_WINDOW"
      && (windowAction.windowId === "equalizer" || windowAction.windowId === "playlist")) {
      togglePanelWindow(windowAction.windowId);
      return action;
    }
    if (windowAction.type === "CLOSE_WINDOW" && windowAction.windowId === windowRole
      && (windowRole === "equalizer" || windowRole === "playlist" || windowRole === "milkdrop")) {
      hidePanelWindow(windowRole);
      return action;
    }
  }
  return originalDispatch(action);
}) as typeof originalDispatch;

void listen<{ shuffle: boolean; repeat: boolean }>("winampfy:transport-modes", ({ payload }) => {
  if (!webamp || !payload) return;
  syncingTransportModes = true;
  try {
    if (webamp.isShuffleEnabled() !== payload.shuffle) {
      webamp.store.dispatch({ type: "TOGGLE_SHUFFLE" });
    }
    if (webamp.isRepeatEnabled() !== payload.repeat) {
      webamp.store.dispatch({ type: "TOGGLE_REPEAT" });
    }
  } finally {
    syncingTransportModes = false;
  }
});

let lastScrolledTrackId: number | null = null;

function scrollCurrentTrackIntoView() {
  if (!webamp) return;
  const state = webamp.store.getState();
  const currentTrackId = state.playlist.currentTrack;
  if (currentTrackId == null) {
    lastScrolledTrackId = null;
    return;
  }
  if (currentTrackId === lastScrolledTrackId) return;
  lastScrolledTrackId = currentTrackId;

  const currentIndex = state.playlist.trackOrder.indexOf(currentTrackId);
  if (currentIndex < 0) return;

  // These are Webamp's Winamp playlist dimensions: the base content area is
  // 58 px, each vertical resize segment adds 29 px, and one row is 13 px.
  const playlistHeightSegments = state.windows.genWindows.playlist?.size[1] ?? 0;
  const visibleTracks = Math.max(1, Math.floor((58 + 29 * playlistHeightSegments) / 13));
  const overflow = Math.max(0, state.playlist.trackOrder.length - visibleTracks);
  if (overflow === 0) return;

  const currentOffset = Math.round((state.display.playlistScrollPosition / 100) * overflow);
  if (currentIndex >= currentOffset && currentIndex < currentOffset + visibleTracks) return;

  const targetOffset = Math.max(0, Math.min(overflow, currentIndex - Math.floor(visibleTracks / 2)));
  webamp.store.dispatch({
    type: "SET_PLAYLIST_SCROLL_POSITION",
    position: (targetOffset / overflow) * 100,
  });
}

let lastSavedPlaylist = JSON.stringify(savedPlaylist);
let lastSavedPlaylistSize = JSON.stringify(savedPlaylistWindowSize);
webamp.store.subscribe(() => {
  if (!webamp) return;
  scrollCurrentTrackIntoView();
  if (windowRole !== "playlist") return;
  const playlistSize = webamp.store.getState().windows.genWindows.playlist?.size;
  const serializedSize = JSON.stringify(playlistSize);
  if (serializedSize !== lastSavedPlaylistSize) {
    lastSavedPlaylistSize = serializedSize;
    localStorage.setItem(PLAYLIST_SIZE_STORAGE_KEY, serializedSize);
  }
  const playlist = webamp
    .getPlaylistTracks()
    .filter((track) => track.url !== "spotify:current")
    .map<PlaylistInputTrack>((track) => ({
      url: track.url,
      defaultName: track.defaultName ?? `${track.artist ?? "Spotify"} - ${track.title ?? "Track"}`,
      metaData: track.artist != null && track.title != null
        ? {
            artist: track.artist,
            title: track.title,
            album: track.album,
          }
        : undefined,
      duration: track.duration ?? 0,
    }));
  const serialized = JSON.stringify(playlist);
  if (serialized === lastSavedPlaylist) return;
  lastSavedPlaylist = serialized;
  localStorage.setItem(PLAYLIST_STORAGE_KEY, serialized);
  // Keep the Rust guard in sync so it can advance to the next queued track
  // when the webview's JS timers are throttled in the background.
  void invoke("player_set_queue", {
    uris: playlist.map((track) => track.url),
  }).catch(() => {});
});

// Only the player window owns application lifetime and the tray minimize
// flow; closing an auxiliary panel just hides it.
if (windowRole === "main") {
  webamp.onClose(() => void invoke("quit_app"));
  webamp.onMinimize(() => {
    void (async () => {
      // Minimizing hides the whole Winamp group, like classic Winamp's
      // minimize on the player window.
      const dialogs = await WebviewWindow.getByLabel("dialogs");
      await dialogs?.hide();
      for (const role of ["equalizer", "playlist", "milkdrop"] as const) {
        const win = await nativePanelWindow(role);
        if (await win?.isVisible()) await win?.hide();
      }
      await getCurrentWindow().hide();
    })();
  });
} else if (isPanelWindow) {
  // Cmd+W / Alt+F4 must hide the panel, not destroy its webview.
  void getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    if (windowRole === "equalizer" || windowRole === "playlist" || windowRole === "milkdrop") {
      hidePanelWindow(windowRole);
    }
  });
}

// The dialogs window hosts the larger overlays and needs no Webamp instance.
if (windowRole === "dialogs") {
  // Cmd+W / Alt+F4 must hide the window, not destroy its webview.
  void getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    void getCurrentWindow().hide();
  });

  void listen<{ kind: "search" | "playlists" | "skins" | "about" }>("winampfy:open-dialog", async (event) => {
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    const kind = event.payload?.kind;
    if (kind === "search") {
      const tracks = await openSpotifySearchDialog();
      if (tracks && tracks.length) await emit("winampfy:append-tracks", tracks);
    } else if (kind === "playlists") {
      const tracks = await openSpotifyPlaylistDialog();
      if (tracks && tracks.length) await emit("winampfy:replace-tracks", tracks);
    } else if (kind === "skins") {
      openSkinExplorerDialog();
    } else if (kind === "about") {
      void openAboutDialog();
    }
  });

  if (openOnboardingDialog()) void getCurrentWindow().show();
  window.setTimeout(() => void checkForAppUpdate(), 1500);
  window.setInterval(() => void checkForAppUpdate(), UPDATE_CHECK_INTERVAL_MS);
} else if (webamp) {
  void webamp.renderInto(document.querySelector<HTMLElement>("#webamp-container")!).then(() => {
    if (windowRole === "playlist") {
      const playlistFont = getComputedStyle(
        document.querySelector<HTMLElement>("#playlist-window")!,
      ).fontFamily;
      document.documentElement.style.setProperty("--playlist-font", playlistFont);
    }
    syncWebampMetadata(latestStatus);
    trackOwnGeometry();
    void restorePanelWindows();

    // A skin applied in any window is picked up by reloading the other
    // windows; the window that applied it keeps its live Webamp instance.
    void listen<{ source: WindowRole }>("winampfy:skin-changed", (event) => {
      if (event.payload?.source === windowRole) return;
      window.location.reload();
    });

    if (windowRole === "main" || windowRole === "milkdrop") {
      // The player and Milkdrop windows keep a hidden "current stream" entry
      // so Webamp has a media target for metadata/playback visualization.
      const tracks = webamp.getPlaylistTracks();
      if (tracks.length > 0) {
        webamp.store.dispatch({
          type: latestStatus.state === "playing" || latestStatus.state === "loading"
            ? "PLAY_TRACK"
            : "BUFFER_TRACK",
          id: tracks[0].id,
        });
      }
    }

    if (windowRole === "main") {

      const panelButtonContainer = document.querySelector("#main-window .windows");
      const panelButtonObserver = new MutationObserver(() => syncNativePanelButtons());
      if (panelButtonContainer) {
        panelButtonObserver.observe(panelButtonContainer, {
          attributes: true,
          subtree: true,
          attributeFilter: ["class"],
        });
      }
      syncNativePanelButtons();
      void listen<WindowsState>("winampfy:windows-state", ({ payload }) => {
        if (payload) syncNativePanelButtons(payload);
      });

      const injectExploreSkinsMenuItem = () => {
        const menu = document.querySelector("#webamp-context-menu");
        if (!menu) return;
        menu.querySelectorAll<HTMLElement>("li.parent").forEach((parent) => {
          const isSkinsMenu = [...parent.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === "Skins",
          );
          if (!isSkinsMenu) return;
          const list = parent.querySelector(":scope > ul");
          if (!list || list.querySelector(".winampfy-explore-skins")) return;
          const loadSkin = [...list.children].find((item) => item.textContent?.trim() === "Load Skin...");
          if (!loadSkin) return;
          const explore = document.createElement("li");
          explore.className = "winampfy-explore-skins";
          explore.textContent = "Explore Skins...";
          loadSkin.insertAdjacentElement("afterend", explore);
        });
      };
      const skinMenuObserver = new MutationObserver(injectExploreSkinsMenuItem);
      skinMenuObserver.observe(document.body, { childList: true, subtree: true });
      injectExploreSkinsMenuItem();

      const syncNativeWindowMenuChecks = () => {
        const menu = document.querySelector("#webamp-context-menu");
        if (!menu) return;
        const windows = loadWindowsState();
        const checkedByLabel: Record<string, boolean> = {
          "Main Window": true,
          Equalizer: windows.equalizer,
          "Playlist Editor": windows.playlist,
          Milkdrop: windows.milkdrop,
        };
        menu.querySelectorAll<HTMLElement>("li").forEach((item) => {
          const label = item.textContent?.trim();
          if (label == null || !(label in checkedByLabel)) return;
          item.classList.toggle("checked", checkedByLabel[label]);
        });
      };

      const injectMilkdropMenuItem = () => {
        const menu = document.querySelector("#webamp-context-menu");
        if (!menu) return;
        if (!menu.querySelector(".winampfy-milkdrop")) {
          const playlistItem = [...menu.querySelectorAll<HTMLElement>("li")]
            .find((item) => item.textContent?.trim() === "Playlist Editor");
          if (!playlistItem) return;
          const milkdropItem = document.createElement("li");
          milkdropItem.className = "winampfy-milkdrop";
          milkdropItem.textContent = "Milkdrop";
          playlistItem.insertAdjacentElement("afterend", milkdropItem);
        }
        syncNativeWindowMenuChecks();
      };
      const milkdropMenuObserver = new MutationObserver(injectMilkdropMenuItem);
      milkdropMenuObserver.observe(document.body, { childList: true, subtree: true });
      injectMilkdropMenuItem();

      // A webview cannot paint a popup beyond its native window bounds. Keep
      // the player itself at 275x116, but temporarily give Webamp's portal menu
      // its original 550x406 canvas so the lower items and submenus are not
      // clipped. The extra canvas is transparent and disappears with the menu.
      let contextMenuWindowExpanded = false;
      const syncContextMenuWindowBounds = () => {
        const menuIsOpen = document.querySelector("#webamp-context-menu .context-menu") != null;
        if (menuIsOpen === contextMenuWindowExpanded) return;
        contextMenuWindowExpanded = menuIsOpen;
        if (menuIsOpen) {
          void getCurrentWindow().setSize(new LogicalSize(550, 406));
          return;
        }
        const player = document.querySelector<HTMLElement>("#main-window");
        const rect = player?.getBoundingClientRect();
        void getCurrentWindow().setSize(new LogicalSize(rect?.width ?? 275, rect?.height ?? 116));
      };
      const contextMenuBoundsObserver = new MutationObserver(syncContextMenuWindowBounds);
      contextMenuBoundsObserver.observe(document.body, { childList: true, subtree: true });
      syncContextMenuWindowBounds();

      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("#webamp-context-menu .winampfy-explore-skins")) {
          event.preventDefault();
          void openDialogWindow("skins");
          return;
        }
        if (target.closest("#webamp-context-menu .winampfy-milkdrop")) {
          event.preventDefault();
          togglePanelWindow("milkdrop");
          return;
        }

        const skinMenuItem = target.closest<HTMLElement>("#webamp-context-menu li");
        if (!skinMenuItem) return;
        const label = skinMenuItem.textContent?.trim();
        const installed = installedSkins.find((skin) => skin.name === label);
        if (installed) {
          localStorage.setItem(ACTIVE_SKIN_STORAGE_KEY, installed.url);
          void emit("winampfy:skin-changed", { source: "main" });
        } else if (label === "<Base Skin>" || label === "Load Skin...") {
          localStorage.removeItem(ACTIVE_SKIN_STORAGE_KEY);
          void emit("winampfy:skin-changed", { source: "main" });
        }
      }, true);

      // Like classic Winamp, double-clicking the small spectrum display opens
      // the full visualization window.
      document.addEventListener("dblclick", (event) => {
        if (!(event.target as HTMLElement).closest("#main-window #visualizer")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePanelWindow("milkdrop");
      }, true);

      // Webamp's lightning-bolt logo is its built-in About control. Keep that
      // authentic hotspot and show Winampfy's native-styled About window instead.
      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("#main-window #about")) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        void openDialogWindow("about");
      }, true);

      // The player's EQ and PL buttons toggle the dedicated native windows
      // instead of panels inside this window.
      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        const toggle = target.closest<HTMLElement>("#equalizer-button, #playlist-button");
        if (!toggle) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePanelWindow(toggle.id === "equalizer-button" ? "equalizer" : "playlist");
      }, true);

      // This window's playlist only holds the placeholder entry, so Webamp's
      // own next/previous would have nothing to advance to. Resolve and load
      // the real persisted queue directly.
      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        const transport = target.closest<HTMLElement>(
          "#main-window .actions #next, #main-window .actions #previous",
        );
        if (!transport) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void advanceTransport(transport.id === "next" ? "next" : "previous", 1);
      }, true);

      document.addEventListener("keydown", (event) => {
        if (event.ctrlKey || event.altKey) return;
        if (event.target instanceof Element
          && ["input", "textarea", "select"].includes(event.target.tagName.toLowerCase())) return;
        // Webamp's own next/previous hotkeys: B, Z and numpad 1/3/4/6.
        const transport: ["next" | "previous", number] | null = event.keyCode === 66 || event.keyCode === 102
          ? ["next", 1]
          : event.keyCode === 90 || event.keyCode === 100
            ? ["previous", 1]
            : event.keyCode === 99
              ? ["next", 10]
              : event.keyCode === 97
                ? ["previous", 10]
                : null;
        if (!transport) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void advanceTransport(...transport);
      }, true);

    }

    if (windowRole === "playlist") {
      // In Winamp the ADD button normally opens a second tiny menu before URL
      // can be selected. Winampfy has one add source, so a single ADD click
      // opens the Spotify search directly and appends the chosen tracks.
      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        const addButton = target.closest<HTMLElement>("#playlist-add-menu");
        if (!addButton || target.closest("#playlist-add-menu ul")) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        void openDialogWindow("search");
      }, true);

      // LIST OPTS → LOAD LIST normally opens a local file picker. Winampfy
      // uses that authentic Winamp control as the entry point for playlists.
      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        const loadListButton = target.closest<HTMLElement>("#playlist-list-menu .load-list");
        if (!loadListButton) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        void openDialogWindow("playlists");
      }, true);

      void listen<PlaylistInputTrack[]>("winampfy:append-tracks", (event) => {
        if (!event.payload?.length) return;
        removeConnectionPlaceholder();
        webamp?.appendTracks(event.payload);
      });
      void listen<PlaylistInputTrack[]>("winampfy:replace-tracks", (event) => {
        if (event.payload?.length) replacePlaylistTracks(event.payload);
      });

    }

    // Auxiliary close buttons hide their native window while the
    // panel itself stays alive inside this instance, ready to be reshown.
    if (windowRole === "equalizer" || windowRole === "playlist" || windowRole === "milkdrop") {
      document.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        const closeButton = target.closest<HTMLElement>(
          windowRole === "equalizer"
            ? "#equalizer-close"
            : windowRole === "playlist"
              ? "#playlist-close-button"
              : ".gen-close",
        );
        if (!closeButton) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        hidePanelWindow(windowRole);
      }, true);
    }

    document.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;

      const target = event.target as HTMLElement;
      const titleBar = target.closest<HTMLElement>(
        "#main-window #title-bar, #equalizer-window .title-bar, " +
        "#playlist-window .playlist-top, .gen-window .gen-top",
      );
      if (!titleBar) return;

      const isWindowControl = target.closest(
        "#option-context, #option, #minimize, #shade, #close, " +
        "#equalizer-close, #equalizer-shade, " +
        "#playlist-close-button, #playlist-shade-button, .gen-close, #gen-resize-target",
      );
      if (isWindowControl) return;

      // Every title bar is native chrome for its own window. The Rust side
      // carries the open sibling panels whenever the player window is dragged;
      // the equalizer and playlist windows always move on their own.
      event.preventDefault();
      event.stopImmediatePropagation();
      void getCurrentWindow().startDragging();
    }, true);
  });
}
