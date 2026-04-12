const { app, BrowserWindow, session, Notification } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 900,
    title: "Clipzioo — Premium YouTube Downloader",
    icon: path.join(__dirname, 'assets', 'icon.png'), // Placeholder for icon
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Handle Downloads to System Downloads Folder
  session.defaultSession.on('will-download', (event, item, webContents) => {
    // Set the save path, making Electron not to prompt a save dialog.
    const downloadsPath = app.getPath('downloads');
    const fileName = item.getFilename();
    const filePath = path.join(downloadsPath, fileName);
    
    item.setSavePath(filePath);

    item.on('updated', (event, state) => {
      if (state === 'interrupted') {
        console.log('Download is interrupted but can be resumed')
      } else if (state === 'progressing') {
        if (item.isPaused()) {
          console.log('Download is paused')
        } else {
          console.log(`Received bytes: ${item.getReceivedBytes()}`)
        }
      }
    });

    item.once('done', (event, state) => {
      if (state === 'completed') {
        console.log('Download successfully');
        new Notification({
          title: 'Download Complete',
          body: `Successfully saved: ${fileName}`
        }).show();
      } else {
        console.log(`Download failed: ${state}`)
      }
    });
  });

  // Start the Express server
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    env: { 
      ...process.env, 
      PORT: 3000,
      ELECTRON_RESOURCES_PATH: process.resourcesPath 
    }
  });

  serverProcess.on('message', (msg) => {
    console.log('Server message:', msg);
  });

  // Load the app with retries to ensure server is ready
  const loadApp = () => {
    mainWindow.loadURL('http://localhost:3000').catch(() => {
      console.log('Server not ready, retrying in 500ms...');
      setTimeout(loadApp, 500);
    });
  };

  loadApp();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});
