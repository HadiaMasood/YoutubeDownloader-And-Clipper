const API = "http://localhost:3000";

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

let totalDuration = 0;
let selectedFormat = "mp4";

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

function resetDownloadUI() {
  progressWrap.style.display = "none";
  downloadBtn.disabled = false;
  dlSpinner.style.display = "none";
  dlBtnText.textContent = "⬇ Download Clip";
}

// Safe JSON fetch — never throws on HTML responses
async function safeJSON(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("Server returned non-JSON response:", text.slice(0, 300));
    throw new Error("Server error. Make sure the server is running (node server.js).");
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

// ── Format pills ──────────────────────────────────────────
pills.forEach(btn => {
  btn.addEventListener("click", () => {
    pills.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedFormat = btn.dataset.fmt;
  });
});

// ── Fetch Info ────────────────────────────────────────────
fetchBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return showStatus("Please enter a YouTube URL.", "error");

  clearStatus();
  fetchBtn.disabled = true;
  fetchBtn.textContent = "Fetching…";

  try {
    const res  = await fetch(`${API}/info?url=${encodeURIComponent(url)}`);
    const data = await safeJSON(res);

    if (data.error) throw new Error(data.error);

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

  } catch (e) {
    showStatus("❌ " + e.message, "error");
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = "Fetch Info";
  }
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

    const res = await fetch(`${API}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        format:    selectedFormat,
        startTime: isFullVideo ? null : Math.floor(startSec),
        endTime:   isFullVideo ? null : Math.ceil(endSec),
      }),
    });

    const data = await safeJSON(res);
    if (data.error) throw new Error(data.error);

    const { jobId } = data;
    if (!jobId) throw new Error("Could not start download job.");

    progressText.textContent = "Download started…";

    // ── Progress polling ──────────────────────────────────
    let stuckCounter = 0;
    let lastProgress = -1;

    const pollInterval = setInterval(async () => {
      try {
        const progRes  = await fetch(`${API}/progress/${jobId}`);
        const { progress, status, error } = await progRes.json();

        if (status === "error") {
          clearInterval(pollInterval);
          showStatus("❌ " + (error || "Download failed on server."), "error");
          resetDownloadUI();
          return;
        }

        // Detect total freeze (same percent for >480 polls = ~8 min)
        if (progress === lastProgress) {
          stuckCounter++;
          if (stuckCounter > 480) {
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
        const label = labels[status] || status;
        progressFill.style.width = progress + "%";
        progressText.textContent = `${label}… ${progress}%`;

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
