import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Webamp from "webamp";
import "./styles.css";

type PlaybackState = "disconnected" | "connecting" | "ready" | "playing" | "paused" | "ended" | "error";
type MediaCallback = (...args: unknown[]) => void;

interface PlayerStatus {
  state: PlaybackState;
  device_name: string;
  message: string;
  track_title: string | null;
  artist: string | null;
  duration_ms: number | null;
  position_ms: number | null;
}

interface SpotifySearchTrack {
  uri: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
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

const disconnectedStatus: PlayerStatus = {
  state: "disconnected",
  device_name: "Winampfy Desktop",
  message: "Press Play to connect Spotify Premium",
  track_title: null,
  artist: null,
  duration_ms: null,
  position_ms: null,
};

const PLAYLIST_STORAGE_KEY = "winampfy.playlist.v1";

let latestStatus = disconnectedStatus;
let webamp: Webamp | null = null;
let lastMetadataKey = "";
let activeTrackUrl = "spotify:current";

class LibrespotMedia {
  private listeners = new Map<string, Set<MediaCallback>>();
  private context = new AudioContext();
  private analyser = this.context.createAnalyser();
  private currentUrl = "spotify:current";
  private pollTimer: number;

  constructor() {
    this.analyser.fftSize = 256;
    this.pollTimer = window.setInterval(() => this.poll(), 300);
    void this.poll();
  }

  private emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((callback) => callback(...args));
  }

  private async poll() {
    try {
      const previous = latestStatus;
      latestStatus = await invoke<PlayerStatus>("player_status");

      if (latestStatus.state === "playing" && previous.state !== "playing") {
        this.emit("playing");
      }
      if (latestStatus.state === "ended" && previous.state !== "ended") {
        this.emit("ended");
      }
      this.emit("timeupdate");
      syncWebampMetadata(latestStatus);
    } catch {}
  }

  on(event: string, callback: MediaCallback) {
    const callbacks = this.listeners.get(event) ?? new Set<MediaCallback>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
  }

  timeElapsed() {
    return (latestStatus.position_ms ?? 0) / 1000;
  }

  duration() {
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

  async loadFromUrl(url: string, autoPlay: boolean) {
    this.currentUrl = url;
    activeTrackUrl = url;
    this.emit("waiting");
    if (url !== "spotify:current") {
      if (latestStatus.state === "disconnected" || latestStatus.state === "error") {
        latestStatus = await invoke<PlayerStatus>("spotify_login");
      }
      await invoke("player_load_uri", { uri: url, autoPlay });
    }
    this.emit("fileLoaded");
    this.emit("stopWaiting");
    if (autoPlay && url === "spotify:current") await this.play();
  }

  setVolume(volume: number) {
    void invoke("player_set_volume", { volume: Math.round(volume) });
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
    this.listeners.clear();
    void this.context.close();
  }
}

function syncWebampMetadata(status: PlayerStatus) {
  if (!webamp) return;
  const playlistTracks = webamp.getPlaylistTracks();
  const currentTrack = playlistTracks.find((track) => track.url === activeTrackUrl);
  if (!currentTrack) return;

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

const savedPlaylist = loadSavedPlaylist();
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
`;

webamp = new Webamp({
  __customMediaClass: LibrespotMedia,
  initialTracks: savedPlaylist.length > 0 ? savedPlaylist : [connectionPlaceholder],
  windowLayout: {
    main: { position: { left: 0, top: 0 } },
    equalizer: { position: { left: 275, top: 0 } },
    playlist: {
      position: { left: 0, top: 116 },
      size: { extraWidth: 11, extraHeight: 6 },
    },
  },
  enableHotkeys: true,
  enableMediaSession: false,
  handleAddUrlEvent: openSpotifySearchDialog,
  handleTrackDropEvent: (event) => {
    const text = event.dataTransfer.getData("text/plain").trim();
    return text ? [{ url: text, defaultName: text, duration: 0 }] : null;
  },
});

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
        removeConnectionPlaceholder();
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
      removeConnectionPlaceholder();
      finish(selected.map(toPlaylistTrack));
    };
  });
}

function removeConnectionPlaceholder() {
  if (!webamp) return;
  const placeholder = webamp.getPlaylistTracks().find((track) => track.url === "spotify:current");
  if (placeholder) {
    webamp.store.dispatch({ type: "REMOVE_TRACKS", ids: [placeholder.id] });
  }
}

const originalDispatch = webamp.store.dispatch;
webamp.store.dispatch = ((action: Parameters<typeof originalDispatch>[0]) => {
  if (typeof action === "object" && action != null && "type" in action) {
    if (action.type === "TOGGLE_SHUFFLE") {
      void invoke("player_set_shuffle", { enabled: !webamp!.isShuffleEnabled() });
    }
    if (action.type === "TOGGLE_REPEAT") {
      void invoke("player_set_repeat", { enabled: !webamp!.isRepeatEnabled() });
    }
  }
  return originalDispatch(action);
}) as typeof originalDispatch;

let lastSavedPlaylist = JSON.stringify(savedPlaylist);
webamp.store.subscribe(() => {
  if (!webamp) return;
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
});

webamp.onClose(() => getCurrentWindow().close());
webamp.onMinimize(() => getCurrentWindow().hide());

void webamp.renderInto(document.querySelector<HTMLElement>("#webamp-container")!).then(() => {
  syncWebampMetadata(latestStatus);

  // In Winamp the ADD button normally opens a second tiny menu before URL can
  // be selected. Winampfy has one add source, so a single ADD click opens the
  // Spotify search directly and appends the chosen tracks.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const addButton = target.closest<HTMLElement>("#playlist-add-menu");
    if (!addButton || target.closest("#playlist-add-menu ul")) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openSpotifySearchDialog().then((tracks) => {
      if (tracks?.length) webamp?.appendTracks(tracks);
    });
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    const titleBar = target.closest<HTMLElement>(
      "#main-window #title-bar, #equalizer-window .title-bar, #playlist-window .playlist-top",
    );
    if (!titleBar) return;

    const isWindowControl = target.closest(
      "#option-context, #option, #minimize, #shade, #close, " +
      "#equalizer-close, #equalizer-shade, " +
      "#playlist-close-button, #playlist-shade-button",
    );
    if (isWindowControl) return;

    // Webamp normally moves its panels inside a virtual desktop. In the
    // desktop app every title bar instead acts as native macOS/Windows chrome.
    event.preventDefault();
    event.stopImmediatePropagation();
    void getCurrentWindow().startDragging();
  }, true);

});
