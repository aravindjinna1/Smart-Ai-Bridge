# AI Bridge Desktop App - Setup Steps

## Step 1: ✅ Preserve Electron Window Configuration in `main.js` (900x550, contentProtection: true, opacity: 0.85, resizable, frame: true)
## Step 2: ✅ Connect App Code (`server.js`) with Electron (`main.js` auto-starts backend server if not already running, retries on load, handles clean exit)
## Step 3: ✅ Fix `package.json` with correct dependencies (`express`, `playwright`, `electron`, `concurrently`) and unified npm scripts (`npm start`, `npm run dev`, `npm run server`, `npm run electron`)
## Step 4: ✅ Fix `start-app.bat` and `run-electron.bat` launcher scripts to point dynamically to this project directory (`%~dp0`) and handle environment variables (`ELECTRON_RUN_AS_NODE`)
## Step 5: ✅ Installed all dependencies (`express`, `playwright`, `electron v28.3.3`, `concurrently`) and verified server + electron setup
