const { spawn, exec, execSync } = require('child_process');
const express    = require('express');
const JSON5      = require('json5');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const os         = require('os');

// --- Load config.json5 ---
const configPath = path.join(__dirname, 'config.json5');
const raw        = fs.readFileSync(configPath, 'utf-8');
const config     = JSON5.parse(raw);

// --- Settings ---
const PORT                 = config.health?.port || 3001;
const UPDATE_INTERVAL_DAYS = config.health?.updateIntervalDays ?? 1;
const THROTTLE_MINUTES     = config.health?.throttleMinutes ?? 10;
const LOG_FILE             = config.health?.logFile || 'hoyobot.log';
const MAX_LOG_LINES        = config.health?.maxLogLines || 100;

// --- Prepare log stream ---
const logFilePath = path.join(__dirname, LOG_FILE);
const logStream   = fs.createWriteStream(logFilePath, { flags: 'a' });
const origLog     = console.log;
const origErr     = console.error;

console.log = (...args) => {
  const msg = args.join(' ') + '\n';
  logStream.write(msg);
  origLog.apply(console, args);
};
console.error = (...args) => {
  const msg = args.join(' ') + '\n';
  logStream.write(msg);
  origErr.apply(console, args);
};

// --- State ---
let botProcess    = null;
let isUp          = false;
let lastStartTime = null;
let lastExitTime  = null;
let autoRestart   = false;
let lastNotify    = { UP: 0, DOWN: 0, RESOURCE: 0 };

// --- Logger ---
function log(level, module, msg) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
  console.log(`${ts} <${level}:${module}> ${msg}`);
}
function logError(module, err) {
  console.error(`${new Date().toISOString().replace('T', ' ').replace(/\..+$/, '')} <ERROR:${module}> ${err.stack || err.message || err}`);
}

// --- Notification ---
async function notifyAll(detail, status) {
  const now = Date.now();
  if (now - (lastNotify[status] || 0) < THROTTLE_MINUTES * 60e3) return;
  lastNotify[status] = now;

  for (const p of config.platforms || []) {
    if (!p.active) continue;
    try {
      if (p.type === 'telegram' && p.token && p.chatId) {
        await axios.post(`https://api.telegram.org/bot${p.token}/sendMessage`, {
          chat_id: p.chatId,
          text: `*Bot Status: ${status}*\n${detail}`,
          parse_mode: 'Markdown',
          disable_notification: p.disableNotification || false,
        });
      } else if (p.type === 'webhook' && p.url) {
        const embed = {
          title: `🤖 Bot Status: ${status}`,
          description: detail,
          color: status === 'UP' ? 0x00FF00 : 0xFF0000,
          timestamp: new Date().toISOString(),
          footer: { text: 'hoyolab-auto monitor' }
        };
        await axios.post(p.url, { embeds: [embed] });
      }
    } catch (e) { logError('Notify', e); }
  }
}

// --- Start Bot ---
function startBot() {
  botProcess = spawn('node', ['index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  isUp = true;
  lastStartTime = Date.now();
  log('INFO', 'Monitor', `Bot started (pid ${botProcess.pid})`);
  notifyAll('Bot started', 'UP').catch(e => logError('Notify', e));

  botProcess.stdout.on('data', data => {
    process.stdout.write(data);
    logStream.write(data);
  });
  botProcess.stderr.on('data', data => {
    process.stderr.write(data);
    logStream.write(data);
  });

  botProcess.on('exit', (code, signal) => {
    isUp = false;
    lastExitTime = Date.now();
    log('WARN', 'Monitor', `Bot exited (code=${code}, signal=${signal})`);
    notifyAll(`Bot exited (code=${code}, signal=${signal})`, 'DOWN');
    if (autoRestart) {
      log('INFO', 'Monitor', 'Auto-restarting in 5s...');
      setTimeout(() => {
        startBot();
        notifyAll('Auto-restarted', 'UP');
      }, 5000);
    }
  });

  botProcess.on('error', err => {
    isUp = false;
    lastExitTime = Date.now();
    logError('Bot', err);
    notifyAll(`Bot error: ${err.message}`, 'DOWN');
  });
}

// --- Auto Update ---
function autoUpdate() {
  log('INFO', 'Monitor', 'Checking for updates...');
  exec('git pull', (err, stdout) => {
    if (err) return logError('Update', err);
    if (/Already up to date/.test(stdout)) {
      log('INFO', 'Monitor', 'Already up to date.');
    } else {
      log('INFO', 'Monitor', `Updated:\n${stdout.trim()}`);
      notifyAll('New version pulled, restarting...', 'UP');
      if (botProcess && isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}
setInterval(autoUpdate, UPDATE_INTERVAL_DAYS * 86400 * 1000);

// --- Get Resources ---
function getResources() {
  const load = os.loadavg()[0].toFixed(2);
  const total = (os.totalmem() / 1048576).toFixed(0);
  const free = (os.freemem() / 1048576).toFixed(0);
  let disk = 'n/a';
  try {
    const df = execSync('df -k .').toString().split('\n')[1].split(/\s+/);
    const used = (df[2] / 1048576).toFixed(1);
    const avail = (df[3] / 1048576).toFixed(1);
    disk = `${used}GiB / ${(Number(used) + Number(avail)).toFixed(1)}GiB`;
  } catch (_) { }
  return { load, mem: `${free}MiB / ${total}MiB`, disk };
}

// --- Format Duration ---
function formatDuration(ms) {
  const s = Math.floor(ms / 1000) % 60,
        m = Math.floor(ms / 60000) % 60,
        h = Math.floor(ms / 3600000) % 24,
        d = Math.floor(ms / 86400000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// --- Tail Logs ---
function tailLogs() {
  try {
    const data = fs.readFileSync(logFilePath, 'utf-8');
    const lines = data.trim().split('\n');
    return lines.slice(-MAX_LOG_LINES).join('\n');
  } catch (_) {
    return 'No log file.';
  }
}

// --- Express ---
const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  const now = Date.now();
  const uptime = isUp ? now - lastStartTime : now - (lastExitTime || now);
  const version = execSync('git rev-parse --short HEAD').toString().trim();
  const logs = tailLogs().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const resources = getResources();

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Bot Dashboard</title>
<style>
body { font-family: sans-serif; max-width: 800px; margin: auto; padding: 1rem; }
.status { font-size: 1.5rem; color: ${isUp ? 'green' : 'red'}; }
pre { background: #eee; padding: 1rem; overflow: auto; max-height: 300px; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ccc; padding: 0.5rem; }
</style></head><body>
<h1>🤖 Bot Dashboard</h1>
<p>Status: <span class="status">${isUp ? 'UP' : 'DOWN'}</span> (${formatDuration(uptime)})</p>
<p>Version: <code>${version}</code></p>
<p>Auto-Restart: <strong>${autoRestart ? 'ON' : 'OFF'}</strong></p>
<form method="POST" action="/control/autorestart">
 <label><input type="checkbox" name="autoRestart" value="on"
 ${autoRestart ? 'checked' : ''} onchange="this.form.submit()"> Enable Auto-Restart</label>
</form>
<form method="POST" action="/control/restart"><button>🔄 Restart Bot</button></form>
<form method="POST" action="/control/update"><button>⬇️ Pull & Update</button></form>
<h2>📊 Resources</h2>
<table>
<tr><th>CPU Load</th><td>${resources.load}</td></tr>
<tr><th>Memory</th><td>${resources.mem}</td></tr>
<tr><th>Disk</th><td>${resources.disk}</td></tr>
</table>
<h2>📝 Logs</h2><pre>${logs}</pre>
</body></html>`);
});

app.post('/control/restart', (req, res) => {
  if (botProcess && isUp) {
    notifyAll('Manual restart triggered.', 'DOWN');
    botProcess.kill('SIGTERM');
  } else {
    startBot();
    notifyAll('Started manually.', 'UP');
  }
  setTimeout(() => res.redirect('/'), 1000);
});

app.post('/control/update', (req, res) => {
  notifyAll('Manual update triggered.', 'DOWN');
  autoUpdate();
  res.redirect('/');
});

app.post('/control/autorestart', (req, res) => {
  autoRestart = req.body.autoRestart === 'on';
  log('INFO', 'Monitor', `AutoRestart: ${autoRestart}`);
  res.redirect('/');
});

// --- Start Server ---
app.listen(PORT, () => {
  log('INFO', 'Monitor', `Web Dashboard running on port ${PORT}`);
  startBot();
  autoUpdate();
});
