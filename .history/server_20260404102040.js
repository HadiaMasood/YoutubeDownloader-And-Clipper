const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

function readPathFile(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), "utf-8").replace(/\r?\n/g, "").trim();
  } catch { return null; }
}

const YTDLP  = readPathFile("ytdlp_path.txt")  || "yt-dlp";
const FFMPEG = readPathFile("ffmpeg_path.txt") || "ffmpeg";

console.log("yt-dlp  path:", YTDLP);
console.log("ffmpeg  path:", FFMPEG);

const TMP = path.join(os.tmpdir(), "ytdl_clips");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
console.log("TMP dir :", TMP);

const jobs = new Map();

function secToHMS(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "Youtube.html")));

app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  let stdout = "", stderr = "";
  const proc = spawn(YTDLP, ["--dump-json", "--no-playlist", "--skip-download", url]);

  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: "yt-dlp could not be started: " + err.message });
  });

  proc.stdout.on("data", d => (stdout += d.toString()));
  proc.stderr.on("data", d => (stderr += d.toString()));
  proc.on("close", code => {
    if (code !== 0) {
      if (!res.headersSent) return res.status(500).json({ error: "Could not fetch video info." });
      return;
    }
    try {
      const data = JSON.parse(stdout);
      res.json({ title: data.title, duration: data.duration, thumbnail: data.thumbnail, uploader: data.uploader || "Unknown" });
    } catch { if (!res.headersSent) res.status(500).json({ error: "Failed to parse info." }); }
  });
});

app.get("/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ progress: job.progress, status: job.status, error: job.error });
});

app.get("/get-file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") return res.status(404).json({ error: "File not ready" });
  res.download(job.filePath, job.fileName, err => {
    if (!err) setTimeout(() => { try { fs.unlinkSync(job.filePath); } catch {} jobs.delete(req.params.jobId); }, 60000);
  });
});

app.post("/download", (req, res) => {
  const { url, startTime, endTime, format = "mp4" } = req.body;
  if (!url) return res.status(400).json({ error: "No URL" });

  const jobId = Date.now().toString();
  const ext = format === "mp3" ? "mp3" : "mp4";
  const filePath = path.join(TMP, `clip_${jobId}.${ext}`);
  const job = { jobId, progress: 0, status: "starting", filePath, fileName: `clip_${jobId}.${ext}`, error: null };
  jobs.set(jobId, job);
  res.json({ jobId });

  console.log(`[${jobId}] New job | format=${format} | startTime=${startTime} | endTime=${endTime}`);

  const hasClip = startTime != null && endTime != null;
  if (hasClip) {
    clipWithFFmpeg(job, url, Number(startTime), Number(endTime), format, filePath);
  } else {
    fullDownload(job, url, format, filePath);
  }
});

function clipWithFFmpeg(job, url, startSec, endSec, format, filePath) {
  job.status = "clipping";
  job.progress = 5;

  const duration = endSec - startSec;
  const startHMS = secToHMS(startSec);
  const endHMS   = secToHMS(endSec);

  console.log(`[${job.jobId}] Clipping: ${startHMS} → ${endHMS} (${duration}s) | Format: ${format}`);

  // ── BOTH MP3 AND MP4: same pipe approach yt-dlp → ffmpeg stdin ──
  const ytArgs = [
    "--no-playlist",
    "--download-sections", `*${startHMS}-${endHMS}`,
    "-f", format === "mp3"
      ? "bestaudio/best"
      : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--output", "matroska:-",
    "--quiet",
    url,
  ];

  const ffArgs = format === "mp3"
    ? ["-i", "pipe:0", "-vn", "-acodec", "libmp3lame", "-ab", "192k", "-y", filePath]
    : ["-i", "pipe:0", "-c", "copy", "-movflags", "+faststart", "-y", filePath];

  console.log(`[${job.jobId}] yt-dlp:`, ytArgs.join(" ").slice(0, 200));

  const ytProc = spawn(YTDLP,  ytArgs);
  const ffProc = spawn(FFMPEG, ffArgs);

  ytProc.stdout.pipe(ffProc.stdin);

  ytProc.stdout.on("end", () => {
    try { ffProc.stdin.end(); } catch(e) {}
  });

  ytProc.on("error", (err) => {
    job.status = "error";
    job.error = "yt-dlp failed: " + err.message;
    console.error(`[${job.jobId}] yt-dlp error:`, err.message);
  });

  ffProc.on("error", (err) => {
    job.status = "error";
    job.error = "ffmpeg failed: " + err.message;
    console.error(`[${job.jobId}] ffmpeg error:`, err.message);
  });

  // Heartbeat: smoothly moves progress while piping happens
  const heartbeat = setInterval(() => {
    if (job.status === "clipping" && job.progress < 92) job.progress += 1;
    else clearInterval(heartbeat);
  }, 1000);

  let ffLog = "";
  ffProc.stderr.on("data", (d) => {
    const txt = d.toString();
    ffLog += txt;
    // Real progress from ffmpeg time=
    const m = txt.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const elapsed = (+m[1] * 3600) + (+m[2] * 60) + parseFloat(m[3]);
      const real = 10 + Math.round((elapsed / Math.max(duration, 1)) * 85);
      if (real > job.progress) job.progress = Math.min(98, real);
    }
  });

  ffProc.on("close", (code) => {
    clearInterval(heartbeat);
    if (code === 0 && fs.existsSync(filePath)) {
      const size = fs.statSync(filePath).size;
      if (size > 1000) {
        job.status = "done";
        job.progress = 100;
        console.log(`[${job.jobId}] ✅ ${format.toUpperCase()} clip done! ${(size/1024).toFixed(0)} KB`);
      } else {
        job.status = "error";
        job.error = "Output file was empty. Try a different clip range.";
      }
    } else {
      job.status = "error";
      job.error = `${format.toUpperCase()} clipping failed.`;
      console.error(`[${job.jobId}] ffmpeg log:`, ffLog.slice(-500));
    }
  });
}

function fullDownload(job, url, format, filePath) {
  job.status = "downloading";

  const tempPath = filePath + ".part";
  const args = [
    "--ffmpeg-location", FFMPEG,
    "--no-playlist",
    "--newline",
    "-o", tempPath,
  ];

  if (format === "mp3") {
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "192K");
  } else {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4");
  }
  args.push(url);

  console.log(`[${job.jobId}] Full download:`, args.join(" ").slice(0, 200));
  const proc = spawn(YTDLP, args);

  proc.on("error", (err) => {
    job.status = "error";
    job.error = "Could not start yt-dlp: " + err.message;
  });

  function parseProgress(line) {
    const m = line.match(/(\d+\.?\d*)%/);
    if (m) job.progress = Math.min(99, Math.round(parseFloat(m[1])));
  }

  proc.stdout.on("data", d => d.toString().split("\n").forEach(parseProgress));
  proc.stderr.on("data", d => d.toString().split("\n").forEach(parseProgress));

  proc.on("close", code => {
    const possible = [tempPath, tempPath + ".mp4", tempPath + ".mp3", tempPath + ".mkv", tempPath + ".webm"];
    let found = possible.find(f => fs.existsSync(f));

    console.log(`[${job.jobId}] yt-dlp exited (code ${code}) | Found: ${found}`);

    if (code === 0 && found) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(found, filePath);
        job.status = "done";
        job.progress = 100;
        console.log(`[${job.jobId}] ✅ Full download complete!`);
      } catch (e) {
        job.status = "error";
        job.error = "Failed to finalize file.";
      }
    } else {
      job.status = "error";
      job.error = "Download failed. Check the URL or try a different format.";
    }
  });
}

app.listen(PORT, () => console.log(`\n✅ Server running → http://localhost:${PORT}\n`));