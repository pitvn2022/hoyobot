// monitor.js
const { spawn } = require('child_process');
const express = require('express');
const JSON5 = require('json5');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');

// --- Load config.json5 ---
const configPath = path.join(__dirname, 'config.json5');
const raw = fs.readFileSync(configPath, 'utf-8');
const config = JSON5.parse(raw);

// --- Settings ---
const port = config.health?.port || 3001;
const EMBED_COLOR_UP   = 0x00FF00; // màu xanh lá
const EMBED_COLOR_DOWN = 0xFF0000; // màu đỏ

// --- State ---
let botProcess = null;
let isUp = false;
let lastStartTime = null;
let lastExitTime = null;
let autoRestart = false;

// --- Logger style giống bot chính ---
function log(level, moduleName, msg) {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace(/\..+$/, '');
  console.log(`${ts} <${level}:${moduleName}> ${msg}`);
}
function logError(moduleName, err) {
  const message = err.stack || err.message || err;
  log('ERROR', moduleName, message);
}

// --- Embed helper cho Discord webhook ---
function makeEmbed(status, detail) {
  return {
    title: `🤖 Bot Status: ${status}`,
    description: detail,
    color: status === 'UP' ? EMBED_COLOR_UP : EMBED_COLOR_DOWN,
    timestamp: new Date().toISOString(),
    footer: {
      text: 'hoyolab-auto monitor',
      // icon_url: 'https://your-domain.com/path/to/icon.png'
    }
  };
}

// --- Notification helper gửi Telegram & Discord webhook ---
async function notifyAll(detail, status) {
  for (const p of config.platforms || []) {
    if (!p.active) continue;
    try {
      if (p.type === 'telegram' && p.token && p.chatId) {
        const url = `https://api.telegram.org/bot${p.token}/sendMessage`;
        await axios.post(url, {
          chat_id: p.chatId,
          text: `*Bot Status: ${status}*\n${detail}`,
          parse_mode: 'Markdown',
          disable_notification: p.disableNotification ?? false,
        });
      }
      else if (p.type === 'webhook' && p.url) {
        const embed = makeEmbed(status, detail);
        await axios.post(p.url, { embeds: [embed] });
      }
    } catch (err) {
      logError('Monitor', err);
    }
  }
}

// --- Spawn bot process & handle events ---
function startBot() {
  botProcess = spawn('node', ['index.js'], { stdio: 'inherit' });
  isUp = true;
  lastStartTime = Date.now();
  log('INFO', 'Monitor', `Bot started (pid ${botProcess.pid})`);
  notifyAll('Bot has started successfully.', 'UP').catch(err => logError('Monitor', err));

  botProcess.on('exit', (code, signal) => {
    isUp = false;
    lastExitTime = Date.now();
    log('WARN', 'Monitor', `Bot exited with code=${code} signal=${signal}`);
    log('DEBUG', 'Monitor', `autoRestart is ${autoRestart}`);
    notifyAll(`Exit code: ${code}, signal: ${signal}`, 'DOWN').catch(err => logError('Monitor', err));
    if (autoRestart) {
      log('INFO', 'Monitor', 'Auto-restart in 5s...');
      setTimeout(() => {
        startBot();
        notifyAll('♻️ Bot was auto-restarted.', 'UP').catch(err => logError('Monitor', err));
      }, 5000);
    }
  });

  botProcess.on('error', err => {
    isUp = false;
    lastExitTime = Date.now();
    logError('Monitor', err);
    notifyAll(`Error: ${err.message}`, 'DOWN').catch(err => logError('Monitor', err));
  });
}

// --- Express health-check + dashboard ---
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

function formatDuration(ms) {
  const secs = Math.floor(ms/1000)%60;
  const mins = Math.floor(ms/60000)%60;
  const hrs  = Math.floor(ms/3600000)%24;
  const days = Math.floor(ms/86400000);
  return [days && `${days}d`, hrs && `${hrs}h`, mins && `${mins}m`, `${secs}s`]
    .filter(Boolean).join(' ');
}

// Root dashboard
app.get('/', (req, res) => {
  const now = Date.now();
  const currentTime = new Date(now).toLocaleString();
  const statusText = isUp ? 'UP' : 'DOWN';
  const sinceMs = isUp ? (now - lastStartTime) : (now - (lastExitTime || now));
  const sinceLabel = isUp ? 'Uptime' : 'Downtime';
  const since = formatDuration(sinceMs);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>Bot Health Dashboard</title>
      <style>
        body { font-family: sans-serif; max-width: 500px; margin: auto; text-align: center; padding: 2rem; }
        .status { font-size: 2rem; margin: 1rem 0; }
        .up { color: green; }
        .down { color: red; }
        button { padding: .5rem 1rem; font-size: 1rem; margin: .5rem; }
        label { font-size: .9rem; }
      </style>
    </head>
    <body>
      <h1>🖥️ Bot Health Dashboard</h1>
      <div>Current time: <strong>${currentTime}</strong></div>
      <div>Auto-Restart: <strong>${autoRestart ? 'ON' : 'OFF'}</strong></div>
      <div class="status ${isUp ? 'up' : 'down'}">
        Status: <strong>${statusText}</strong>
      </div>
      <div>${sinceLabel}: <strong>${since}</strong></div>
      <form method="POST" action="/control/restart">
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

// Manual restart endpoint
app.post('/control/restart', (req, res) => {
  if (botProcess && isUp) {
    notifyAll('⚠️ Bot is going DOWN (manual restart)...', 'DOWN').catch(err => logError('Monitor', err));
    botProcess.kill('SIGTERM');
  }
  setTimeout(() => {
    startBot();
    notifyAll('🔄 Bot was manually restarted by user.', 'UP').catch(err => logError('Monitor', err));
  }, 1000);
  res.redirect('/');
});

// Auto-restart toggle endpoint
app.post('/control/autorestart', (req, res) => {
  autoRestart = req.body.autoRestart === 'on';
  log('INFO', 'Monitor', `Toggled Auto-Restart → ${autoRestart}`);
  res.redirect('/');
});

// Start server & bot
app.listen(port, () => {
  log('INFO', 'Monitor', `Health-check server listening on :${port}`);
  startBot();
});
