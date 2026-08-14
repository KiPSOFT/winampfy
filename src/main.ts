import { Channel, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import Webamp from "webamp";
import "./styles.css";

type PlaybackState = "disconnected" | "connecting" | "ready" | "playing" | "paused" | "ended" | "error";
type MediaCallback = (...args: unknown[]) => void;
type AppUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

interface PlayerStatus {
  state: PlaybackState;
  device_name: string;
  message: string;
  track_title: string | null;
  artist: string | null;
  duration_ms: number | null;
  position_ms: number | null;
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

const disconnectedStatus: PlayerStatus = {
  state: "disconnected",
  device_name: "Winampfy Desktop",
  message: "Press Play to connect Spotify Premium",
  track_title: null,
  artist: null,
  duration_ms: null,
  position_ms: null,
  advance_sequence: 0,
};

const PLAYLIST_STORAGE_KEY = "winampfy.playlist.v1";
const WINAMP_LOGO_URL = new URL("../src-tauri/icons/winamp-logo.png", import.meta.url).href;

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
  private pollInFlight = false;
  private lastAdvanceSequence = 0;
  private desiredVolume: number | null = null;
  private appliedVolume = 72;
  private volumeUpdateInFlight = false;
  private volumeSyncTimer: number | null = null;

  constructor() {
    this.analyser.fftSize = 256;
    this.pollTimer = window.setInterval(() => this.poll(), 300);
    void this.poll();
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
      if (latestStatus.advance_sequence !== this.lastAdvanceSequence) {
        this.lastAdvanceSequence = latestStatus.advance_sequence;
        this.emit("ended");
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
  <div id="spotify-playlist-dialog" class="search-dialog" hidden>
    <section class="search-panel" role="dialog" aria-modal="true" aria-labelledby="playlist-search-title">
      <header>
        <i class="title-rule" aria-hidden="true"></i>
        <span id="playlist-search-title">LOAD LIST // SPOTIFY PLAYLISTS</span>
        <i class="title-rule" aria-hidden="true"></i>
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
        <button id="about-ok" type="button">OK</button>
      </footer>
    </section>
  </div>
`;

let updateCheckStarted = false;

async function checkForAppUpdate() {
  if (window.location.hostname === "localhost" || updateCheckStarted) return;
  updateCheckStarted = true;
  try {
    const update = await check();
    if (update) showUpdateDialog(update);
  } catch (error) {
    // Update checks should never interrupt music playback. A missing release
    // manifest or an offline connection will simply be retried next launch.
    console.warn("Winampfy update check failed", error);
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

  const dismiss = () => {
    dialog.hidden = true;
    void update.close();
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
  const okButton = document.querySelector<HTMLButtonElement>("#about-ok")!;
  const version = document.querySelector<HTMLElement>("#about-version")!;

  dialog.hidden = false;
  version.textContent = "VERSION ...";

  const close = () => {
    dialog.hidden = true;
    dialog.onkeydown = null;
  };
  closeButton.onclick = close;
  okButton.onclick = close;
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
  window.setTimeout(() => input.focus(), 0);

  return new Promise((resolve) => {
    let results: SpotifyPlaylistSummary[] = [];
    let urlSearchTimer: number | null = null;
    let searchRequestId = 0;

    const finish = (tracks: PlaylistInputTrack[] | null) => {
      if (urlSearchTimer != null) window.clearTimeout(urlSearchTimer);
      dialog.hidden = true;
      form.onsubmit = null;
      input.oninput = null;
      closeButton.onclick = null;
      loadButton.onclick = null;
      resultsElement.onchange = null;
      resultsElement.ondblclick = null;
      dialog.onkeydown = null;
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
          <time>${playlist.track_count} TRACKS</time>
        `;
        row.querySelector("strong")!.textContent = playlist.name;
        row.querySelector("small")!.textContent = `${visibility} — ${playlist.owner || "Spotify"}`;
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
webamp.store.subscribe(() => {
  if (!webamp) return;
  scrollCurrentTrackIntoView();
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

webamp.onClose(() => void invoke("quit_app"));
webamp.onMinimize(() => getCurrentWindow().hide());

void webamp.renderInto(document.querySelector<HTMLElement>("#webamp-container")!).then(() => {
  const playlistFont = getComputedStyle(
    document.querySelector<HTMLElement>("#playlist-window")!,
  ).fontFamily;
  document.documentElement.style.setProperty("--playlist-font", playlistFont);
  syncWebampMetadata(latestStatus);
  window.setTimeout(() => void checkForAppUpdate(), 1500);

  // Webamp's lightning-bolt logo is its built-in About control. Keep that
  // authentic hotspot and show Winampfy's native-styled About window instead.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest("#main-window #about")) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openAboutDialog();
  }, true);

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

  // LIST OPTS → LOAD LIST normally opens a local file picker. Winampfy uses
  // that authentic Winamp control as the entry point for Spotify playlists.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const loadListButton = target.closest<HTMLElement>("#playlist-list-menu .load-list");
    if (!loadListButton) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openSpotifyPlaylistDialog().then((tracks) => {
      if (tracks?.length) replacePlaylistTracks(tracks);
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
