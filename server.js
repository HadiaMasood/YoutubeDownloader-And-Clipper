require('dotenv').config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

const EXE_DIR = path.join(__dirname, "bin");

function getBinaryPath(name) {
  const isWin = process.platform === "win32";
  const exeName = name + (isWin ? ".exe" : "");

  // 1. Check local bin/ folder (Development)
  const localPath = path.join(EXE_DIR, exeName);
  if (fs.existsSync(localPath)) return localPath;

  // 2. Check resources/bin (Production Packaged)
  const resPath = process.env.ELECTRON_RESOURCES_PATH || process.resourcesPath;
  if (resPath) {
    const prodPath = path.join(resPath, "bin", exeName);
    if (fs.existsSync(prodPath)) return prodPath;
  }

  // 3. Fallback to system path
  return name;
}

const YTDLP = getBinaryPath("yt-dlp");
const FFMPEG = getBinaryPath("ffmpeg");
const FFMPEG_DIR = path.dirname(FFMPEG);

console.log("yt-dlp  path:", YTDLP);
console.log("ffmpeg  path:", FFMPEG);

const TMP = path.join(os.tmpdir(), "ytdl_clips");
if (!fs.existsSync(TMP)) {
  fs.mkdirSync(TMP, { recursive: true });
} else {
  // Cleanup old files on startup
  try {
    const files = fs.readdirSync(TMP);
    for (const file of files) {
      if (file.startsWith("rawvid_") || file.startsWith("rawaud_") || file.startsWith("clip_") || file.endsWith(".part")) {
        try { fs.unlinkSync(path.join(TMP, file)); } catch { }
      }
    }
    console.log("Cleared old temp files in", TMP);
  } catch (e) {
    console.error("Failed to clear TMP items:", e.message);
  }
}
console.log("TMP dir :", TMP);

// Cleanup job files every 2 hours - prevents disk bloat from abandoned jobs
setInterval(() => {
  try {
    const files = fs.readdirSync(TMP);
    const now = Date.now();
    for (const file of files) {
      const fullPath = path.join(TMP, file);
      const stat = fs.statSync(fullPath);
      // Delete files older than 2 hours
      if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
        try { fs.unlinkSync(fullPath); } catch { }
      }
    }
  } catch (e) {
    console.error("Cleanup interval error:", e.message);
  }
}, 30 * 60 * 1000); // Every 30 minutes

const jobs = new Map();

// Kill a process after timeout with proper cleanup
function setProcessTimeout(proc, jobId, timeoutMs, label) {
  const timeoutHandle = setTimeout(() => {
    if (!proc.killed) {
      console.error(`[${jobId}] ⏱️ ${label} timeout (${timeoutMs}ms), killing process...`);
      try {
        process.kill(-proc.pid); // Kill entire process group
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch { }
      }
    }
  }, timeoutMs);

  proc.on("exit", () => clearTimeout(timeoutHandle));
  return timeoutHandle;
}

function secToHMS(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── Quality helpers ───────────────────────────────────────────────────────────
function getMp4Format(quality) {
  // Balanced selection for full downloads
  switch (quality) {
    case "1080p": return "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
    case "720p":  return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/bestvideo[height<=720]+bestaudio/best[height<=720]/best";
    case "480p":  return "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/bestvideo[height<=480]+bestaudio/best[height<=480]/best";
    case "360p":  return "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=360]/bestvideo[height<=360]+bestaudio/best[height<=360]/best";
    default:      return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best";
  }
}
function getMp4ClipFormat(quality) {
  // Priority: 
  // 1. mp4 video + m4a audio (best for mp4 container, fast merge)
  // 2. pre-muxed mp4
  // 3. Any best video + best audio (will merge to mp4)
  switch (quality) {
    case "1080p": return "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
    case "720p":  return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/bestvideo[height<=720]+bestaudio/best[height<=720]/best";
    case "480p":  return "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]/bestvideo[height<=480]+bestaudio/best[height<=480]/best";
    case "360p":  return "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=360]/bestvideo[height<=360]+bestaudio/best[height<=360]/best";
    default:      return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best";
  }
}
function getMp3Bitrate(quality) {
  if (quality === "320k") return "320K";
  if (quality === "128k") return "128K";
  return "192K"; // default
}

// ── Routes ────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "Youtube.html")));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/config.js", (req, res) => {
  const config = {
    API_URL: process.env.API_URL || ""
  };
  res.setHeader("Content-Type", "application/javascript");
  res.send(`window.ENV = ${JSON.stringify(config)};`);
});

app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  console.log(`[INFO] Fetching info for: ${url}`);
  
  let stdout = "", stderr = "";
  const proc = spawn(YTDLP, ["--dump-json", "--no-playlist", "--skip-download", url]);
  
  proc.on("error", (err) => {
    console.error("[INFO ERROR] Process error:", err);
    if (!res.headersSent) res.status(500).json({ error: "yt-dlp could not be started: " + err.message });
  });
  
  proc.stdout.on("data", d => (stdout += d.toString()));
  proc.stderr.on("data", d => (stderr += d.toString()));
  
  proc.on("close", code => {
    if (code !== 0) {
      console.error(`[INFO ERROR] yt-dlp exited with code ${code}`);
      console.error(`[INFO ERROR] stderr: ${stderr}`);
      if (!res.headersSent) return res.status(500).json({ error: "Could not fetch video info. " + (stderr.split('\n')[0] || "") });
      return;
    }
    try {
      const data = JSON.parse(stdout);
      console.log(`[INFO SUCCESS] Title: ${data.title}`);
      res.json({ title: data.title, duration: data.duration, thumbnail: data.thumbnail, uploader: data.uploader || "Unknown" });
    } catch (e) { 
      console.error("[INFO ERROR] Parse error:", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to parse info." }); 
    }
  });
});

// ── Playlist info endpoint ───────────────────────────────────────────────────
app.get("/playlist-info", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "No URL" });

  const args = [
    "--no-playlist", // for the initial call just in case, but we want the list
    "--flat-playlist",
    "--dump-single-json",
    "--playlist-items", "1-20", // limit to first 20 for speed
    url
  ];

  const proc = spawn(YTDLP, args);
  let output = "";
  proc.stdout.on("data", d => output += d.toString());
  proc.on("close", code => {
    try {
      const data = JSON.parse(output);
      const entries = data.entries || [];
      const result = entries.map(e => ({
        id: e.id,
        title: e.title,
        url: `https://www.youtube.com/watch?v=${e.id}`,
        duration: e.duration || 0,
        thumbnail: e.thumbnail || (e.thumbnails ? e.thumbnails[0].url : "")
      }));
      res.json({ title: data.title, entries: result });
    } catch (e) {
      res.status(500).json({ error: "Failed to parse playlist." });
    }
  });
});

// ── Proxy download endpoint for thumbnails ──────────────────────────────────
app.get("/download-thumb", (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl) return res.status(400).send("No URL");

  const protocol = imgUrl.startsWith("https") ? https : http;
  protocol.get(imgUrl, imgRes => {
    res.setHeader("Content-Disposition", 'attachment; filename="thumbnail.jpg"');
    imgRes.pipe(res);
  });
});

app.get("/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ progress: job.progress, status: job.status, error: job.error });
});

// ── Cancel endpoint ───────────────────────────────────────────────────────────
app.post("/cancel/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return res.json({ ok: false, msg: "Job already finished" });
  }
  job.status = "cancelled";
  job.error = "Cancelled by user";
  (job.procs || []).forEach(p => { try { p.kill("SIGKILL"); } catch { } });
  try { if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch { }
  console.log(`[${job.jobId}] ❌ Cancelled by user`);
  res.json({ ok: true });
});

app.get("/get-file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") return res.status(404).json({ error: "File not ready" });
  res.download(job.filePath, job.fileName, err => {
    if (!err) setTimeout(() => { try { fs.unlinkSync(job.filePath); } catch { } jobs.delete(req.params.jobId); }, 60000);
  });
});

app.post("/download", (req, res) => {
  const { url, startTime, endTime, format = "mp4", quality = "best", title = "", thumbnail = "" } = req.body;
  if (!url) return res.status(400).json({ error: "No URL" });

  const jobId = Date.now().toString();
  const ext = format === "mp3" ? "mp3" : "mp4";
  const filePath = path.join(TMP, `clip_${jobId}.${ext}`);
  const job = { jobId, progress: 0, status: "starting", filePath, fileName: `clip_${jobId}.${ext}`, error: null, procs: [], title, thumbnail };
  jobs.set(jobId, job);
  res.json({ jobId });

  console.log(`[${jobId}] New job | format=${format} | quality=${quality} | start=${startTime} | end=${endTime}`);

  const hasClip = startTime != null && endTime != null;
  if (hasClip) {
    clipWithFFmpeg(job, url, Number(startTime), Number(endTime), format, quality, filePath);
  } else {
    fullDownload(job, url, format, quality, filePath);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIP MODE
// ─────────────────────────────────────────────────────────────────────────────
function clipWithFFmpeg(job, url, startSec, endSec, format, quality, filePath) {
  job.status = "clipping";
  job.progress = 5;

  const duration = endSec - startSec;
  const startHMS = secToHMS(startSec);
  const endHMS = secToHMS(endSec);

  console.log(`[${job.jobId}] Clipping ${startHMS}→${endHMS} (${duration}s) | format=${format} | quality=${quality}`);

  if (format === "mp3") {
    clipMp3TwoStep(job, url, startSec, endSec, duration, startHMS, endHMS, quality, filePath);
  } else {
    clipMp4Pipe(job, url, duration, startHMS, endHMS, quality, filePath);
  }
}

// ── MP3 clip: two-step (yt-dlp full audio → ffmpeg trim+convert) ────────────
// yt-dlp downloads the full audio, then ffmpeg trims the exact clip range.
// This is reliable because yt-dlp handles YouTube auth/throttling internally.
function clipMp3TwoStep(job, url, startSec, endSec, duration, startHMS, endHMS, quality, filePath) {
  const tempAudio = path.join(TMP, `rawaud_${job.jobId}.%(ext)s`);
  const bitrate   = getMp3Bitrate(quality);

  // Phase 1: download raw audio
  const ytArgs = [
    "--no-playlist",
    "-f", "ba/b",
    "--output", tempAudio,
    "--no-part",
    "--newline",
    "--progress-template", "download:%(progress._percent_str)s",
  ];
  if (FFMPEG_DIR) ytArgs.push("--ffmpeg-location", FFMPEG_DIR);
  ytArgs.push(url);

  console.log(`[${job.jobId}] Phase1: downloading full audio`);
  const ytProc = spawn(YTDLP, ytArgs);
  job.procs.push(ytProc);
  setProcessTimeout(ytProc, job.jobId, 45 * 60 * 1000, "yt-dlp Phase1 (download audio)");

  // Heartbeat: keeps bar moving 5→60 while yt-dlp works
  const heartbeat1 = setInterval(() => {
    if (job.status !== "clipping") { clearInterval(heartbeat1); return; }
    if (job.progress < 55) job.progress += 0.3;
  }, 800);

  ytProc.on("error", (err) => {
    clearInterval(heartbeat1);
    job.status = "error";
    job.error  = "yt-dlp failed to start: " + err.message;
  });

  let ytLog = "";
  ytProc.stdout.on("data", (d) => {
    const lines = d.toString().split("\n");
    lines.forEach(line => {
      ytLog += line + "\n";
      const m = line.match(/download:(\d+\.?\d*)%/);
      if (m) {
        const mapped = 5 + Math.round(parseFloat(m[1]) * 0.55); // 0-100 → 5-60
        if (mapped > job.progress) job.progress = Math.min(60, mapped);
      }
    });
  });
  ytProc.stderr.on("data", (d) => { ytLog += d.toString(); });

  ytProc.on("close", async (ytCode) => {
    clearInterval(heartbeat1);
    console.log(`[${job.jobId}] Phase1 exit code=${ytCode}`);

    if (ytCode !== 0) {
      job.status = "error";
      job.error  = "Failed to download audio.";
      console.error(`[${job.jobId}] yt-dlp log:`, ytLog.slice(-400));
      return;
    }

    // Find downloaded file
    let foundAudio = null;
    try {
      const prefix = `rawaud_${job.jobId}`;
      const candidates = fs.readdirSync(TMP)
        .filter(f => f.startsWith(prefix) && !f.endsWith(".part"))
        .map(f => path.join(TMP, f));
      if (candidates.length > 0) {
        foundAudio = candidates.reduce((a, b) =>
          (fs.existsSync(b) && fs.statSync(b).size > (fs.existsSync(a) ? fs.statSync(a).size : 0)) ? b : a
        );
      }
    } catch (e) {
      console.error(`[${job.jobId}] readdir error:`, e.message);
    }

    if (!foundAudio || !fs.existsSync(foundAudio)) {
      job.status = "error";
      job.error  = "No audio file produced.";
      return;
    }

    job.progress = 65;
    console.log(`[${job.jobId}] Phase2: ffmpeg trim ${path.basename(foundAudio)} → mp3`);

    // Phase 2: ffmpeg trims + converts
    const ffArgs = [
      "-ss", startSec.toString(),
      "-i",  foundAudio,
      "-t",  duration.toString(),
    ];

    // Thumbnail embedding
    const thumbPath = path.join(TMP, `thumb_${job.jobId}.jpg`);
    let hasCover = false;
    if (job.thumbnail) {
      try {
        await new Promise((resolve, reject) => {
          const protocol = job.thumbnail.startsWith("https") ? https : http;
          const file = fs.createWriteStream(thumbPath);
          protocol.get(job.thumbnail, (r) => {
            r.pipe(file);
            file.on("finish", () => { file.close(); resolve(); });
          }).on("error", reject);
        });
        ffArgs.push("-i", thumbPath);
        hasCover = true;
      } catch (e) {
        console.error("Thumb download failed:", e.message);
      }
    }

    ffArgs.push("-c:a", "libmp3lame", "-b:a", bitrate);
    if (hasCover) {
      ffArgs.push("-map", "0:a", "-map", "1:v", "-id3v2_version", "3",
        "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
    }
    if (job.title) ffArgs.push("-metadata", `title=${job.title}`);
    ffArgs.push("-y", filePath);

    // Heartbeat: 65→99 during ffmpeg trim
    const heartbeat2 = setInterval(() => {
      if (job.status !== "clipping") { clearInterval(heartbeat2); return; }
      if (job.progress < 95) job.progress += 0.8;
      else if (job.progress < 99) job.progress += 0.1;
    }, 500);

    const ffProc = spawn(FFMPEG, ffArgs);
    job.procs.push(ffProc);
    setProcessTimeout(ffProc, job.jobId, 10 * 60 * 1000, "ffmpeg Phase2 (trim+convert)");

    ffProc.on("error", (err) => {
      clearInterval(heartbeat2);
      job.status = "error";
      job.error  = "ffmpeg failed: " + err.message;
      try { fs.unlinkSync(foundAudio); } catch {}
    });

    let ffLog = "";
    ffProc.stderr.on("data", (d) => {
      const txt = d.toString();
      ffLog += txt;
      const m = txt.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        const elapsed = (+m[1] * 3600) + (+m[2] * 60) + parseFloat(m[3]);
        const pct = 65 + Math.round((elapsed / Math.max(duration, 1)) * 33);
        if (pct > job.progress) job.progress = Math.min(98, pct);
      }
    });

    ffProc.on("close", (ffCode) => {
      clearInterval(heartbeat2);
      try { fs.unlinkSync(foundAudio); } catch {}
      if (hasCover) try { fs.unlinkSync(thumbPath); } catch {}

      if (ffCode === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
        job.status   = "done";
        job.progress = 100;
        console.log(`[${job.jobId}] ✅ MP3 clip done!`);
      } else {
        job.status = "error";
        job.error  = "MP3 conversion failed or output empty.";
        console.error(`[${job.jobId}] ffmpeg log:`, ffLog.slice(-600));
      }
    });
  });
}

// ── MP4 clip: yt-dlp --download-sections (reliable, handles YouTube auth) ────
function clipMp4Pipe(job, url, duration, startHMS, endHMS, quality, filePath) {
  const hmsToSec = (hms) => {
    const p = hms.split(":").map(Number);
    return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1];
  };
  const startSec = hmsToSec(startHMS);
  const endSec   = hmsToSec(endHMS);
  const section  = `*${startSec}-${endSec}`;
  const tempVideo = path.join(TMP, `rawvid_${job.jobId}.mp4`);
  const fmt       = getMp4ClipFormat(quality);

  const ytArgs = [
    "--no-playlist",
    "-f", fmt,
    "--download-sections", section,
    "--merge-output-format", "mp4",
    "--output", tempVideo,
    "--no-part",
    "--no-mtime",
    "--newline",
    "--progress-template", "download:%(progress._percent_str)s",
    "--concurrent-fragments", "5",
    "--extractor-args", "youtube:player_client=android,web;player_skip=configs,js",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  ];
  if (FFMPEG_DIR) ytArgs.push("--ffmpeg-location", FFMPEG_DIR);
  ytArgs.push(url);

  console.log(`[${job.jobId}] MP4 clip | section: ${section} | quality: ${quality} | fmt: ${fmt}`);
  const ytProc = spawn(YTDLP, ytArgs);
  job.procs.push(ytProc);
  setProcessTimeout(ytProc, job.jobId, 30 * 60 * 1000, "yt-dlp MP4 Clip");

  // Heartbeat: slow crawl up to 99 so bar never freezes during yt-dlp merge phase
  const heartbeat = setInterval(() => {
    if (job.status !== "clipping") { clearInterval(heartbeat); return; }
    if (job.progress < 95)       job.progress += 0.5;   // download phase
    else if (job.progress < 99) job.progress += 0.08;  // silent merge phase — very slow crawl
  }, 600);

  ytProc.on("error", (err) => {
    clearInterval(heartbeat);
    job.status = "error";
    job.error  = "yt-dlp failed: " + err.message;
  });

  let ytLog = "";
  ytProc.stdout.on("data", (d) => {
    const lines = d.toString().split("\n");
    lines.forEach(line => {
      console.log(`[${job.jobId}] yt-dlp: ${line}`);
      ytLog += line + "\n";
      const m = line.match(/download:(\d+\.?\d*)%/);
      if (m) {
        const mapped = 5 + Math.round(parseFloat(m[1]) * 0.93);
        if (mapped > job.progress) job.progress = Math.min(99, mapped);
      }
    });
  });
  ytProc.stderr.on("data", (d) => {
    const lines = d.toString().split("\n");
    lines.forEach(line => {
      console.error(`[${job.jobId}] yt-dlp err: ${line}`);
      ytLog += line + "\n";
    });
  });

  ytProc.on("close", (ytCode) => {
    clearInterval(heartbeat);
    console.log(`[${job.jobId}] yt-dlp exit=${ytCode}`);

    let foundFile = null;
    try {
      const prefix = `rawvid_${job.jobId}`;
      const candidates = fs.readdirSync(TMP)
        .filter(f => f.startsWith(prefix) && !f.endsWith(".part"))
        .map(f => path.join(TMP, f));
      if (candidates.length > 0) {
        foundFile = candidates.reduce((a, b) =>
          (fs.statSync(b).size > fs.statSync(a).size ? b : a)
        );
      }
      console.log(`[${job.jobId}] Selected:`, foundFile ? path.basename(foundFile) : "none");
    } catch (e) {
      console.error(`[${job.jobId}] TMP readdir error:`, e.message);
    }

    if (ytCode !== 0 || !foundFile) {
      job.status = "error";
      job.error  = "Clip download failed.";
      console.error(`[${job.jobId}] exit=${ytCode} | log:`, ytLog.slice(-300));
      return;
    }

    try {
      if (foundFile !== filePath) fs.renameSync(foundFile, filePath);
    } catch (e) {
      job.status = "error";
      job.error  = "Could not finalize file: " + e.message;
      return;
    }

    job.status   = "done";
    job.progress = 100;
    console.log(`[${job.jobId}] ✅ MP4 clip done!`);
  });
}



// ── Full download mode ────────────────────────────────────────────────────────
function fullDownload(job, url, format, quality, filePath) {
  job.status = "downloading";

  const args = [
    "--no-playlist",
    "--newline",
    "--no-part",
    "-o", filePath,
    "--concurrent-fragments", "5",
    "--extractor-args", "youtube:player_client=android,web;player_skip=configs,js",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "--no-mtime",
  ];

  if (FFMPEG_DIR && FFMPEG_DIR !== ".") {
    args.push("--ffmpeg-location", FFMPEG_DIR);
  } else if (FFMPEG && FFMPEG !== "ffmpeg") {
    // If we have an absolute path to ffmpeg, passing its directory is safest
    args.push("--ffmpeg-location", path.dirname(FFMPEG));
  }

  if (format === "mp3") {
    const bitrate = getMp3Bitrate(quality);
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", bitrate);
  } else {
    args.push("-f", getMp4Format(quality), "--merge-output-format", "mp4");
  }
  args.push(url);

  console.log(`[${job.jobId}] Full download: format=${format} quality=${quality}`);
  const proc = spawn(YTDLP, args);
  job.procs.push(proc);

  // Full download timeout - 60 min for very large videos
  setProcessTimeout(proc, job.jobId, 60 * 60 * 1000, "yt-dlp Full Download");

  // Heartbeat: keeps bar moving during silent ffmpeg conversion phase
  // After yt-dlp finishes download (100%), it runs ffmpeg internally to convert
  // to mp3. During this, NO progress lines are emitted → bar would freeze at 99%.
  // This heartbeat slowly advances to 99.8 so it never looks frozen.
  const heartbeat = setInterval(() => {
    if (job.status !== "downloading") { clearInterval(heartbeat); return; }
    if (job.progress >= 90 && job.progress < 99.8) {
      job.progress += 0.15; // steady crawl through the silent conversion phase
    }
  }, 500);

  proc.on("error", (err) => {
    clearInterval(heartbeat);
    job.status = "error";
    job.error = "Could not start yt-dlp: " + err.message;
  });

  function parseProgress(line) {
    const m = line.match(/(\d+\.?\d*)%/);
    if (m) job.progress = Math.min(99, Math.round(parseFloat(m[1])));
  }

  let ytLog = "";
  proc.stdout.on("data", d => {
    const lines = d.toString().split("\n");
    lines.forEach(line => {
      console.log(`[${job.jobId}] yt-dlp: ${line}`);
      ytLog += line + "\n";
      parseProgress(line);
    });
  });
  proc.stderr.on("data", d => {
    const lines = d.toString().split("\n");
    lines.forEach(line => {
      console.error(`[${job.jobId}] yt-dlp error: ${line}`);
      ytLog += line + "\n";
      parseProgress(line);
    });
  });

  proc.on("close", code => {
    clearInterval(heartbeat);
    // Find downloaded file accurately
    let found = null;
    try {
      // Direct path since we use --no-part and -o filePath
      if (fs.existsSync(filePath)) {
        found = filePath;
      } else {
        // Fallback: If yt-dlp decided to use a different extension (e.g. .mkv or .webm)
        const possible = [
          filePath.replace(".mp4", ".mkv"),
          filePath.replace(".mp4", ".webm"),
          filePath.replace(".mp4", ".m4a")
        ];
        found = possible.find(f => fs.existsSync(f));
      }
    } catch (e) {
      console.error(`[${job.jobId}] File search error:`, e.message);
    }

    console.log(`[${job.jobId}] yt-dlp exited (code ${code}) | found: ${found}`);

    if (code === 0 && found) {
      try {
        if (found !== filePath) {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          fs.renameSync(found, filePath);
        }
        job.status = "done";
        job.progress = 100;
        console.log(`[${job.jobId}] ✅ Full download done!`);
      } catch (e) {
        job.status = "error";
        job.error = "Failed to finalize file.";
        console.error(`[${job.jobId}] Finalize error:`, e.message);
      }
    } else {
      job.status = "error";
      // Capture the last bit of the log to help the user understand why it failed
      const lastErr = ytLog.split("\n").filter(l => l.toLowerCase().includes("error")).pop() || "";
      job.error = lastErr ? `yt-dlp error: ${lastErr.slice(0, 100)}` : "Download failed. Try a different format or URL.";
      console.error(`[${job.jobId}] Download failed log tail:`, ytLog.slice(-500));
    }
  });
}

app.listen(PORT, () => console.log(`\n✅ Server running → http://localhost:${PORT}\n`));