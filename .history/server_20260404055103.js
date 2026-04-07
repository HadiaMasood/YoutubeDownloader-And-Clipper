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

// ── Keep server alive on unexpected errors ────────────────
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

// ── Read absolute paths ───────────────────────────────────
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

// ── Routes ────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "Youtube.html")));

app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  let stdout = "", stderr = "";
  const proc = spawn(YTDLP, ["--dump-json", "--no-playlist", "--skip-download", url]);

  proc.on("error", (err) => {
    console.error("[/info] spawn error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "yt-dlp could not be started: " + err.message });
  });

  proc.stdout.on("data", d => (stdout += d.toString()));
  proc.stderr.on("data", d => (stderr += d.toString()));
  proc.on("close", code => {
    if (code !== 0) {
      console.error("yt-dlp info error:", stderr.slice(0, 300));
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

// ── CLIP MODE ─────────────────────────────────────────────────────────────────
//
//  MP4: yt-dlp pipes Matroska → ffmpeg stdin (fast, stream copy)
//  MP3: yt-dlp downloads clipped audio to temp file → ffmpeg converts (reliable)
//
function clipWithFFmpeg(job, url, startSec, endSec, format, filePath) {
  job.status = "clipping";
  job.progress = 5;

  const duration = endSec - startSec;
  const startHMS = secToHMS(startSec);
  const endHMS   = secToHMS(endSec);

  console.log(`[${job.jobId}] ✂️  Clipping: ${startHMS} → ${endHMS} (${duration}s) | Format: ${format}`);

  if (format === "mp3") {
    // ── MP3: Step 1: get direct URL, Step 2: ffmpeg clips+encodes ───────────
    //  -ss AFTER -i = output seeking (reliable, fast for audio-only streams)
    //  ffmpeg decodes audio from start (super fast for audio), encodes only clip
    const ytArgs = ["--no-playlist", "-f", "bestaudio/best", "--get-url", url];

    console.log(`[${job.jobId}] Step 1: getting audio URL...`);
    const ytProc = spawn(YTDLP, ytArgs);

    let audioUrl = "", ytErr = "";
    ytProc.stdout.on("data", d => { audioUrl += d.toString(); });
    ytProc.stderr.on("data", d => { ytErr += d.toString(); });

    const hb1 = setInterval(() => {
      if (job.progress < 10) job.progress += 1;
    }, 500);

    ytProc.on("error", err => {
      clearInterval(hb1);
      job.status = "error"; job.error = "yt-dlp failed: " + err.message;
    });

    ytProc.on("close", ytCode => {
      clearInterval(hb1);
      audioUrl = audioUrl.trim().split("\n")[0].trim();
      console.log(`[${job.jobId}] URL resolved (code ${ytCode}, len=${audioUrl.length})`);

      if (ytCode !== 0 || !audioUrl) {
        job.status = "error";
        job.error = "Could not get audio URL. " + ytErr.slice(0, 200);
        return;
      }

      job.progress = 12;
      console.log(`[${job.jobId}] Step 2: ffmpeg -i <url> -ss ${startSec} -t ${duration} → MP3`);

      // -ss BEFORE -i = input seeking. ffmpeg seeks through stream first (fast),
      // then decodes from seek point. Much faster and more reliable for streaming URLs.
      const ffArgs = [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-ss", String(startSec),
        "-i", audioUrl,
        "-t", String(duration),
        "-vn",
        "-acodec", "libmp3lame",
        "-ab", "192k",
        "-y", filePath,
      ];

      const ffProc = spawn(FFMPEG, ffArgs);
      let ffLog = "";
      let gotFirstTime = false;

      // Heartbeat while ffmpeg is seeking to the start position
      const hb2 = setInterval(() => {
        if (job.status !== "clipping") { clearInterval(hb2); return; }
        if (!gotFirstTime && job.progress < 40) job.progress += 1;
      }, 700);

      ffProc.stderr.on("data", d => {
        const txt = d.toString();
        ffLog += txt;
        // time= goes from 00:00:00 to clip duration
        const m = txt.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          gotFirstTime = true;
          const elapsed = (+m[1] * 3600) + (+m[2] * 60) + parseFloat(m[3]);
          const pct = 40 + Math.round((elapsed / duration) * 58);
          if (pct > job.progress) job.progress = Math.min(98, pct);
        }
      });

      ffProc.on("error", err => {
        clearInterval(hb2);
        job.status = "error"; job.error = "ffmpeg failed: " + err.message;
      });

      ffProc.on("close", ffCode => {
        clearInterval(hb2);
        console.log(`[${job.jobId}] ffmpeg exited (code ${ffCode})`);

        if (ffCode === 0 && fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          if (size > 1000) {
            job.status = "done";
            job.progress = 100;
            console.log(`[${job.jobId}] ✅ MP3 clip done! ${(size/1024).toFixed(0)} KB`);
          } else {
            job.status = "error";
            job.error = "Output MP3 was empty.";
          }
        } else {
          job.status = "error";
          job.error = "MP3 conversion failed.";
          console.error(`[${job.jobId}] ffmpeg log:`, ffLog.slice(-600));
        }
      });
    });

  } else {
    // ── MP4: pipe mode (yt-dlp → ffmpeg stdin, fast stream copy) ────────────
    const ytArgs = [
      "--no-playlist",
      "--download-sections", `*${startHMS}-${endHMS}`,
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--output", "matroska:-",
      "--quiet",
      url,
    ];

    const ffArgs = ["-i", "pipe:0", "-c", "copy", "-movflags", "+faststart", "-y", filePath];

    const ytProc = spawn(YTDLP,  ytArgs);
    const ffProc = spawn(FFMPEG, ffArgs);

    ytProc.stdout.pipe(ffProc.stdin);

    ytProc.stdout.on("end", () => {
      try { ffProc.stdin.end(); } catch(e) {}
    });

    const heartbeat = setInterval(() => {
      if (job.status === "clipping" && job.progress < 92) job.progress += 1;
      else clearInterval(heartbeat);
    }, 1500);

    ytProc.on("error", (err) => {
      clearInterval(heartbeat);
      job.status = "error"; job.error = "yt-dlp failed: " + err.message;
    });

    ffProc.on("error", (err) => {
      clearInterval(heartbeat);
      job.status = "error"; job.error = "ffmpeg failed: " + err.message;
    });

    let ffLog = "";
    ffProc.stderr.on("data", (d) => {
      const txt = d.toString();
      ffLog += txt;
      const m = txt.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        const elapsed = (+m[1] * 3600) + (+m[2] * 60) + parseFloat(m[3]);
        const real = 10 + Math.round((elapsed / duration) * 85);
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
          console.log(`[${job.jobId}] ✅ MP4 clip complete! Size: ${size} bytes`);
        } else {
          job.status = "error";
          job.error = "The output file was empty.";
        }
      } else {
        job.status = "error";
        job.error = "MP4 clipping failed.";
        console.error(`[${job.jobId}] ffmpeg log tail:`, ffLog.slice(-500));
      }
    });
  }
}


// ── Full download mode ────────────────────────────────────
function fullDownload(job, url, format, filePath) {
  job.status = "downloading";

  // Use a temporary name for yt-dlp to avoid conflicts, then rename to filePath
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

  console.log(`[${job.jobId}] Full download args:`, args.join(" ").slice(0, 200));
  const proc = spawn(YTDLP, args);

  proc.on("error", (err) => {
    console.error(`[${job.jobId}] yt-dlp spawn error:`, err.message);
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
    // yt-dlp might append its own extension (e.g. .mp4 or .mp3) to tempPath
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
        console.error(`[${job.jobId}] Rename error:`, e.message);
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
