// monitor.js
const { spawn } = require('child_process');
const express = require('express');
const JSON5 = require('json5');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

// --- Load config ---
const configPath = path.join(__dirname, 'config.json5');
const raw = fs.readFileSync(configPath, 'utf-8');
const config = JSON5.parse(raw);
const port = config.health?.port || 3001;

// --- State ---
let botProcess = null;
let isUp = false;
let lastStartTime = null;
let lastExitTime = null;
let autoRestart = false;

// --- Spawn bot ---
function startBot() {
  botProcess = spawn('node', ['index.js'], { stdio: ['inherit','inherit','inherit'] });
  isUp = true;
  lastStartTime = Date.now();
  console.log(`🟢 Bot started (pid ${botProcess.pid})`);

  botProcess.on('exit', (code, signal) => {
    isUp = false;
    lastExitTime = Date.now();
    console.log(`🔴 Bot exited with code=${code} signal=${signal}`);
    if (autoRestart) {
      console.log('♻️ Auto-restart in 5s...');
      setTimeout(startBot, 5000);
    }
  });
  botProcess.on('error', err => {
    isUp = false;
    lastExitTime = Date.now();
    console.error('❌ Bot failed to start:', err);
  });
}

// --- Express app ---
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Helper: format uptime/down duration
function formatDuration(ms) {
  const secs = Math.floor(ms/1000)%60;
  const mins = Math.floor(ms/60000)%60;
  const hrs  = Math.floor(ms/3600000)%24;
  const days = Math.floor(ms/86400000);
  return [days&&`${days}d`, hrs&&`${hrs}h`, mins&&`${mins}m`, `${secs}s`]
    .filter(Boolean).join(' ');
}

// Root UI
app.get('/', (req, res) => {
  const now = Date.now();
  const currentTime = new Date(now).toLocaleString();
  let statusText = isUp ? 'UP' : 'DOWN';
  let since = isUp
    ? formatDuration(now - lastStartTime)
    : formatDuration(now - (lastExitTime || now));
  let sinceLabel = isUp ? 'Uptime' : 'Downtime';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>Bot Health</title>
      <style>
        body { font-family: sans-serif; text-align: center; padding: 2rem; }
        .status { font-size: 2rem; margin: 1rem 0; }
        .up { color: green; }
        .down { color: red; }
        button { padding: .5rem 1rem; font-size: 1rem; }
        label { font-size: .9rem; }
      </style>
    </head>
    <body>
      <h1>🖥️ Bot Health Dashboard</h1>
      <div>Current time: <strong>${currentTime}</strong></div>
      <div class="status ${isUp ? 'up' : 'down'}">
        Status: <strong>${statusText}</strong>
      </div>
      <div>${sinceLabel}: <strong>${since}</strong></div>
      <form method="POST" action="/control/restart" style="margin:1rem 0;">
        <button type="submit">🔄 Restart Bot</button>
      </form>
      <form method="POST" action="/control/autorestart">
        <label>
          <input type="checkbox" name="autoRestart" value="on"
            ${autoRestart ? 'checked' : ''} onchange="this.form.submit()"/>
          Enable Auto-Restart
        </label>
      </form>
    </body>
    </html>
  `);
});

// Restart endpoint
app.post('/control/restart', (req, res) => {
  if (botProcess && isUp) {
    botProcess.kill('SIGTERM');
  }
  // nếu đang down, khởi luôn
  if (!isUp) {
    startBot();
  }
  res.redirect('/');
});

// Auto-restart toggle
app.post('/control/autorestart', (req, res) => {
  autoRestart = req.body.autoRestart === 'on';
  res.redirect('/');
});

// Lắng nghe và sau đó spawn bot
app.listen(port, () => {
  console.log(`🌐 Health-check server listening on :${port}`);
  startBot();
});
