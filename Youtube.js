const API = (window.ENV && window.ENV.API_URL) ? window.ENV.API_URL : window.location.origin;



const urlInput        = document.getElementById("urlInput");
const fetchBtn        = document.getElementById("fetchBtn");
const videoInfo       = document.getElementById("videoInfo");
const thumbImg        = document.getElementById("thumbImg");
const videoTitle      = document.getElementById("videoTitle");
const videoUploader   = document.getElementById("videoUploader");
const videoDuration   = document.getElementById("videoDuration");
const clipCard        = document.getElementById("clipCard");
const startSlider     = document.getElementById("startSlider");
const endSlider       = document.getElementById("endSlider");
const sliderFill      = document.getElementById("sliderFill");
const clipDurationText= document.getElementById("clipDurationText");
const startInput      = document.getElementById("startInput");
const endInput        = document.getElementById("endInput");
const durationLabel   = document.getElementById("durationLabel");
const downloadBtn     = document.getElementById("downloadBtn");
const dlSpinner       = document.getElementById("dlSpinner");
const dlBtnText       = document.getElementById("dlBtnText");
const progressWrap    = document.getElementById("progressWrap");
const progressFill    = document.getElementById("progressFill");
const progressText    = document.getElementById("progressText");
const statusBox       = document.getElementById("statusBox");
const pills           = document.querySelectorAll(".pill");
const playlistWrap    = document.getElementById("playlistWrap");
const playlistList    = document.getElementById("playlistList");
const saveThumbBtn    = document.getElementById("saveThumbBtn");

let totalDuration  = 0;
let selectedFormat  = "mp4";
let selectedQuality = "best";
let currentJobId    = null;


// ── Quality pills builder ────────────────────────────────────────────
const MP4_QUALITIES = [
  { label: "Best",  value: "best"  },
  { label: "1080p", value: "1080p" },
  { label: "720p",  value: "720p"  },
  { label: "480p",  value: "480p"  },
  { label: "360p",  value: "360p"  },
];
const MP3_QUALITIES = [
  { label: "320k",  value: "320k" },
  { label: "192k",  value: "192k" },
  { label: "128k",  value: "128k" },
];

function buildQualityPills(format) {
  const container = document.getElementById("qualityPills");
  const list = format === "mp3" ? MP3_QUALITIES : MP4_QUALITIES;
  // default to first option for the format
  selectedQuality = list[0].value;
  container.innerHTML = list.map((q, i) =>
    `<button class="q-pill${i === 0 ? " active" : ""}" data-q="${q.value}">${q.label}</button>`
  ).join("");
  container.querySelectorAll(".q-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".q-pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedQuality = btn.dataset.q;
    });
  });
}

function hideAllInfo() {
  videoInfo.style.display    = "none";
  clipCard.style.display     = "none";
  playlistWrap.style.display = "none";
}

// ── Helpers ───────────────────────────────────────────────
function secToHMS(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
    : `${m}:${String(sec).padStart(2,"0")}`;
}

function hmsToSec(str) {
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60  + parts[1];
  return parts[0] || 0;
}

function showStatus(msg, type) {
  statusBox.textContent = msg;
  statusBox.className = `status ${type}`;
}

function clearStatus() {
  statusBox.className = "status";
  statusBox.textContent = "";
}

const cancelBtn = document.getElementById("cancelBtn");

function resetDownloadUI() {
  progressWrap.style.display = "none";
  cancelBtn.style.display    = "none";
  downloadBtn.disabled = false;
  dlSpinner.style.display = "none";
  dlBtnText.textContent = "⬇ Download Clip";
  currentJobId = null;
}

// Safe JSON fetch — never throws on HTML responses
async function safeJSON(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("Server returned non-JSON response:", text.slice(0, 300));
    throw new Error("Local service error. Please restart the application.");
  }
}

// Friendly fetch — converts "Failed to fetch" into a readable message
async function apiFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    if (e.message === "Failed to fetch" || e.name === "TypeError") {
      throw new Error("Cannot connect to server. Please restart the app.");
    }
    throw e;
  }
}

// ── Slider ────────────────────────────────────────────────
function updateSliderFill() {
  const s   = Number(startSlider.value);
  const e   = Number(endSlider.value);
  const max = Number(startSlider.max) || 1;

  const pctStart = (s / max) * 100;
  const pctEnd   = (e / max) * 100;
  sliderFill.style.left  = pctStart + "%";
  sliderFill.style.width = (pctEnd - pctStart) + "%";

  const startSec = (s / max) * totalDuration;
  const endSec   = (e / max) * totalDuration;
  const diff     = Math.max(0, endSec - startSec);
  const isFull   = (s === 0 && e === max);

  clipDurationText.textContent = isFull ? "full video" : secToHMS(diff);
  startInput.value = secToHMS(startSec);
  endInput.value   = secToHMS(endSec);
}

function handleManualInput() {
  const sSec = hmsToSec(startInput.value);
  const eSec = hmsToSec(endInput.value);
  const max  = Number(startSlider.max);
  startSlider.value = Math.min(max - 1, (sSec / totalDuration) * max);
  endSlider.value   = Math.max(Number(startSlider.value) + 1, (eSec / totalDuration) * max);
  updateSliderFill();
}

startInput.addEventListener("change", handleManualInput);
endInput.addEventListener("change", handleManualInput);

startSlider.addEventListener("input", () => {
  if (Number(startSlider.value) >= Number(endSlider.value))
    startSlider.value = Number(endSlider.value) - 1;
  updateSliderFill();
});

endSlider.addEventListener("input", () => {
  if (Number(endSlider.value) <= Number(startSlider.value))
    endSlider.value = Number(startSlider.value) + 1;
  updateSliderFill();
});

// ── Format pills ──────────────────────────────────────────────────────────
pills.forEach(btn => {
  btn.addEventListener("click", () => {
    pills.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedFormat = btn.dataset.fmt;
    buildQualityPills(selectedFormat); // update quality pills for new format
  });
});
buildQualityPills("mp4"); // init with mp4 defaults

// ── Fetch Info ────────────────────────────────────────────
fetchBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return showStatus("Please enter a YouTube URL.", "error");

  clearStatus();
  fetchBtn.disabled = true;
  fetchBtn.textContent = "Fetching…";
  hideAllInfo();

  // Detailed check: If it has 'v=', it's ALWAYS a single video, even if it has 'list='
  const isPlaylist = (url.includes("list=") || url.includes("/playlist?")) && !url.includes("v=");

  try {
    if (isPlaylist) {
      const res = await apiFetch(`${API}/playlist-info?url=${encodeURIComponent(url)}`);
      const data = await safeJSON(res);
      if (data.error) throw new Error(data.error);

      renderPlaylist(data.entries);
      playlistWrap.style.display = "block";
      showStatus("Playlist detected! Select a video to clip.", "success");
    } else {
      await loadVideo(url);
    }
  } catch (e) {
    showStatus("❌ " + e.message, "error");
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = "Fetch Info";
  }
});

async function loadVideo(url) {
  try {
    // Clean URL: Remove list= and other params if they exist, keep only v=
    let cleanUrl = url;
    if (url.includes("v=")) {
      const vMatch = url.match(/[?&]v=([^&]+)/);
      if (vMatch) cleanUrl = `https://www.youtube.com/watch?v=${vMatch[1]}`;
    }
    
    urlInput.value = cleanUrl;
    hideAllInfo(); // Reset UI immediately to avoid flashes
    
    clearStatus();
    fetchBtn.disabled = true;
    fetchBtn.textContent = "Loading clip...";

    const res  = await apiFetch(`${API}/info?url=${encodeURIComponent(url)}`);
    const data = await safeJSON(res);

    if (data.error) throw new Error(data.error);

    hideAllInfo(); // Reset UI before showing new info
    totalDuration       = data.duration;
    thumbImg.src        = data.thumbnail;
    videoTitle.textContent    = data.title;
    videoUploader.textContent = data.uploader;
    videoDuration.textContent = secToHMS(data.duration);
    videoInfo.style.display   = "block";

    const maxSteps = Math.min(totalDuration, 3600);
    startSlider.max = endSlider.max = maxSteps;
    startSlider.value = 0;
    endSlider.value   = maxSteps;
    durationLabel.textContent = secToHMS(totalDuration);
    updateSliderFill();

    clipCard.style.display  = "block";
    downloadBtn.disabled    = false;
    
    window.scrollTo({ top: videoInfo.offsetTop - 20, behavior: 'smooth' });
    
    // Triple-assure playlist is hidden and info is shown
    playlistWrap.style.display = "none";
    videoInfo.style.display = "block";
    clipCard.style.display = "block";

  } catch (e) {
    showStatus("❌ " + e.message, "error");
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = "Fetch Info";
  }
}

// Global expose so onclick works
window.loadVideo = loadVideo;

function renderPlaylist(entries) {
  playlistList.innerHTML = entries.map(e => `
    <div class="playlist-item" onclick="loadVideo('${e.url}')">
      <img src="${e.thumbnail}" class="pl-thumb">
      <div class="pl-title">${e.title}</div>
    </div>
  `).join("");
}

// ── Save Thumbnail handler ────────────────────────────────
saveThumbBtn.addEventListener("click", () => {
  const thumb = thumbImg.src;
  if (!thumb) return;
  window.open(`${API}/download-thumb?url=${encodeURIComponent(thumb)}`, '_blank');
});

// ── Download ──────────────────────────────────────────────
downloadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;

  clearStatus();
  downloadBtn.disabled = true;
  dlSpinner.style.display = "block";
  dlBtnText.textContent   = "Processing…";
  progressWrap.style.display = "block";
  progressFill.style.width   = "0%";
  progressText.textContent   = "Connecting to server…";

  try {
    const startSec  = (Number(startSlider.value) / Number(startSlider.max)) * totalDuration;
    const endSec    = (Number(endSlider.value)   / Number(endSlider.max))   * totalDuration;
    const isFullVideo = (Number(startSlider.value) === 0 &&
                         Number(endSlider.value)   === Number(endSlider.max));

    const res = await apiFetch(`${API}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        format:    selectedFormat,
        quality:   selectedQuality,
        title:     videoTitle.textContent,
        thumbnail: thumbImg.src,
        startTime: isFullVideo ? null : Math.floor(startSec),
        endTime:   isFullVideo ? null : Math.ceil(endSec)
      }),
    });

    const data = await safeJSON(res);
    if (data.error) throw new Error(data.error);

    const { jobId } = data;
    if (!jobId) throw new Error("Could not start download job.");

    currentJobId = jobId;
    cancelBtn.style.display  = "block";
    progressText.textContent = "Download started…";

    // ── Progress polling ──────────────────────────────────
    let stuckCounter = 0;
    let lastProgress = -1;

    const pollInterval = setInterval(async () => {
      try {
        const progRes  = await fetch(`${API}/progress/${jobId}`);
        const { progress, status, error } = await progRes.json();

        if (status === "error" || status === "cancelled") {
          clearInterval(pollInterval);
          const msg = status === "cancelled" ? "Download cancelled." : (error || "Download failed on server.");
          showStatus((status === "cancelled" ? "❌ " : "❌ ") + msg, "error");
          resetDownloadUI();
          return;
        }

        // Detect total freeze (same percent for >480 polls = ~8 min)
        if (progress === lastProgress) {
          stuckCounter++;
          if (stuckCounter > 900) {  // ~15 min tolerance for long videos
            clearInterval(pollInterval);
            showStatus("❌ Download seems stuck. Try a shorter clip or different video.", "error");
            resetDownloadUI();
            return;
          }
        } else {
          stuckCounter = 0;
          lastProgress = progress;
        }

        const labels = { preparing: "Preparing", clipping: "Clipping", downloading: "Downloading", starting: "Starting" };
        // Show 'Converting' when download is done but ffmpeg is still processing
        const isConverting = status === "downloading" && progress >= 99;
        const label = isConverting ? "Converting" : (labels[status] || status);
        const displayPct = Math.floor(progress); // avoid 98.0999... decimals
        progressFill.style.width = progress + "%";
        progressText.textContent = `${label}… ${displayPct}%`;

        if (status === "done") {
          clearInterval(pollInterval);
          progressFill.style.width = "100%";
          progressText.textContent = "✅ Done! Saving file…";

          // Trigger download
          const a = document.createElement("a");
          a.href = `${API}/get-file/${jobId}`;
          document.body.appendChild(a);
          a.click();
          a.remove();

          showStatus("✅ Download successful! Enjoy your clip.", "success");
          saveToHistory({
            title:     videoTitle.textContent,
            thumbnail: thumbImg.src,
            url:       urlInput.value.trim(),
            format:    selectedFormat,
            quality:   selectedQuality,
            isClip:    !isFullVideo,
            clipStart: isFullVideo ? null : startInput.value,
            clipEnd:   isFullVideo ? null : endInput.value,
            date:      new Date().toISOString(),
          });
          setTimeout(resetDownloadUI, 3000);
        }

      } catch (e) {
        clearInterval(pollInterval);
        showStatus("❌ " + e.message, "error");
        resetDownloadUI();
      }
    }, 1000);

  } catch (e) {
    showStatus("❌ " + e.message, "error");
    resetDownloadUI();
  }
});

// ── Cancel handler ──────────────────────────────────────────────────────
cancelBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  try {
    await fetch(`${API}/cancel/${currentJobId}`, { method: "POST" });
    showStatus("❌ Download cancelled.", "error");
  } catch (e) {
    showStatus("❌ Could not cancel: " + e.message, "error");
  }
  resetDownloadUI();
});

// ── Download History ──────────────────────────────────────────────────
const HISTORY_KEY = "ytclipper_history";

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 50))); } // max 50 entries

function saveToHistory(entry) {
  const h = loadHistory();
  h.unshift({ id: Date.now(), ...entry });
  saveHistory(h);
  renderHistory();
}

function renderHistory() {
  const h = loadHistory();
  const list     = document.getElementById("historyList");
  const empty    = document.getElementById("historyEmpty");
  const clearBtn = document.getElementById("clearHistoryBtn");

  // Remove old items (keep empty/clearBtn)
  list.querySelectorAll(".history-item").forEach(el => el.remove());

  if (h.length === 0) {
    empty.style.display    = "block";
    clearBtn.style.display = "none";
    return;
  }
  empty.style.display    = "none";
  clearBtn.style.display = "block";

  h.forEach(entry => {
    const div = document.createElement("div");
    div.className = "history-item";
    const dateStr = new Date(entry.date).toLocaleDateString("en-PK", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    const rangeStr = entry.isClip ? `${entry.clipStart} → ${entry.clipEnd}` : "Full Video";
    div.innerHTML = `
      <img class="history-thumb" src="${entry.thumbnail || ""}" alt="" onerror="this.style.display='none'">
      <div class="history-info">
        <div class="history-title">${entry.title || "Unknown"}</div>
        <div class="history-meta">${dateStr} • ${rangeStr}</div>
      </div>
      <span class="history-badge">${entry.format.toUpperCase()} ${entry.quality}</span>
    `;
    list.insertBefore(div, clearBtn);
  });
}

// History toggle
document.getElementById("historyToggle").addEventListener("click", () => {
  const list = document.getElementById("historyList");
  const icon = document.getElementById("historyIcon");
  list.classList.toggle("open");
  icon.classList.toggle("open");
});

// Clear history
document.getElementById("clearHistoryBtn").addEventListener("click", () => {
  if (confirm("Clear all download history?")) {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }
});

// Load history on page start
renderHistory();
