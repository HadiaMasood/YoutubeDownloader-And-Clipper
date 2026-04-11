# YT Clipper Pro - Installation Guide

## 📦 What's Included:
- YT Clipper application files
- License key for activation
- This installation guide

## 🚀 Quick Start (3 Steps):

### Step 1: Install Requirements
1. **Node.js** (if not installed):
   - Download from: https://nodejs.org
   - Install the LTS version (recommended)

2. **yt-dlp** (required):
   - Download from: https://github.com/yt-dlp/yt-dlp/releases
   - Place `yt-dlp.exe` in the `bin` folder

3. **ffmpeg** (required):
   - Download from: https://www.gyan.dev/ffmpeg/builds/
   - Extract and place `ffmpeg.exe` in the `bin` folder

### Step 2: Install Dependencies
1. Open Command Prompt in the YT Clipper folder
2. Run: `npm install`

### Step 3: Launch Application
1. Double-click `START.bat` (Windows)
2. Or run: `npm start`
3. Browser will open automatically at http://localhost:3000

## 🔑 Activation:
When the app opens, enter your license key:
```
YOUR-LICENSE-KEY-HERE
```
(Check your purchase email for the key)

## ⚙️ Folder Structure:
```
YT-Clipper/
├── bin/              (Place yt-dlp.exe and ffmpeg.exe here)
├── server.js         (Backend server)
├── Youtube.html      (Frontend UI)
├── Youtube.js        (Frontend logic)
├── package.json      (Dependencies)
└── START.bat         (Quick launcher)
```

## 🆘 Troubleshooting:

**Problem**: "yt-dlp not found"
- **Solution**: Download yt-dlp.exe and place in `bin` folder

**Problem**: "ffmpeg not found"
- **Solution**: Download ffmpeg.exe and place in `bin` folder

**Problem**: "Port 3000 already in use"
- **Solution**: Close other apps using port 3000, or edit `server.js` line 10 to change port

**Problem**: License key not working
- **Solution**: Copy-paste the key exactly as provided (no extra spaces)

## 📧 Support:
Email: your-email@example.com
Response time: 24-48 hours

## ⚠️ Important Notes:
- This tool is for personal/educational use only
- Respect YouTube's Terms of Service
- Don't distribute copyrighted content
- Keep your license key private

## 🔄 Updates:
Check your email for update notifications. Download new versions from your Gumroad library.

---
Thank you for your purchase! 🎉
Enjoy YT Clipper Pro!
