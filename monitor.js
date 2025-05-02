// monitor.js
const { spawn, exec, execSync } = require('child_process');
const express = require('express');
const JSON5 = require('json5');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const os = require('os');

// --- Load config.json5 ---
const configPath = path.join(__dirname, 'config.json5');
const raw = fs.readFileSync(configPath, 'utf-8');
const config = JSON5.parse(raw);

// --- Settings ---
const PORT = config.health?.port || 3001;
const UPDATE_INTERVAL_DAYS = config.health?.updateIntervalDays ?? 1;
const THROTTLE_MINUTES = config.health?.throttleMinutes ?? 10;
const LOG_FILE = config.health?.logFile || 'hoyobot.log';
const MAX_LOG_LINES = config.health?.maxLogLines || 100;

// --- Prepare log stream & override console ---
const logFilePath = path.join(__dirname, LOG_FILE);
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
const origLog = console.log;
const origErr = console.error;

// Khi gọi console.log/error, đồng thời ghi vào file
console.log = function (...args) {
  const msg = args.join(' ') + '\n';
  logStream.write(msg);
  origLog.apply(console, args);
};
console.error = function (...args) {
  const msg = args.join(' ') + '\n';
  logStream.write(msg);
  origErr.apply(console, args);
};

// --- State ---
let botProcess = null;
let isUp = false;
let lastStartTime = null;
let lastExitTime = null;
let autoRestart = false;
let lastNotify = { UP: 0, DOWN: 0, RESOURCE: 0 };

// --- Logger (bot style) ---
function log(level, moduleName, msg) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
  console.log(`${ts} <${level}:${moduleName}> ${msg}`);
}
function logError(moduleName, err) {
  console.error(`${new Date().toISOString().replace('T', ' ').replace(/\..+$/, '')} <ERROR:${moduleName}> ${err.stack || err.message || err}`);
}

// --- Notification helper w/ throttling ---
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
      }
      else if (p.type === 'webhook' && p.url) {
        const embed = {
          title: `🤖 Bot Status: ${status}`,
          description: detail,
          color: status === 'UP' ? 0x00FF00 : 0xFF0000,
          timestamp: new Date().toISOString(),
          footer: { text: 'hoyolab-auto monitor' }
        };
        await axios.post(p.url, { embeds: [embed] });
      }
    } catch (e) { logError('Monitor', e); }
  }
}

// --- Spawn bot & lifecycle, pipe logs to both console & file ---
function startBot() {
  botProcess = spawn('node', ['index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  isUp = true;
  lastStartTime = Date.now();
  log('INFO', 'Monitor', `Bot started (pid ${botProcess.pid})`);
  notifyAll('Bot has started successfully.', 'UP').catch(e => logError('Monitor', e));

  // Bot stdout → console + file
  botProcess.stdout.on('data', data => {
    process.stdout.write(data);
    logStream.write(data);
  });
  // Bot stderr → console.error + file
  botProcess.stderr.on('data', data => {
    process.stderr.write(data);
    logStream.write(data);
  });

  botProcess.on('exit', (code, signal) => {
    isUp = false;
    lastExitTime = Date.now();
    log('WARN', 'Monitor', `Bot exited code=${code} signal=${signal}`);
    notifyAll(`Exit code: ${code}, signal: ${signal}`, 'DOWN').catch(e => logError('Monitor', e));
    if (autoRestart) {
      log('INFO', 'Monitor', 'Auto-restart in 5s...');
      setTimeout(() => {
        startBot();
        notifyAll('♻️ Auto-restarted.', 'UP').catch(e => logError('Monitor', e));
      }, 5000);
    }
  });

  botProcess.on('error', err => {
    isUp = false;
    lastExitTime = Date.now();
    logError('Monitor', err);
    notifyAll(`Error: ${err.message}`, 'DOWN').catch(e => logError('Monitor', e));
  });
}

// --- Auto-update daily ---
function autoUpdate() {
  log('INFO', 'Monitor', 'Checking for updates (git pull)...');
  exec('git pull', (err, stdout) => {
    if (err) { logError('Monitor', err); return; }
    if (/Already up to date\./.test(stdout)) {
      log('INFO', 'Monitor', 'No updates.');
    } else {
      log('INFO', 'Monitor', `Pulled:\n${stdout.trim()}`);
      notifyAll('🚀 New code pulled, restarting...', 'UP');
      if (botProcess && isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}
setInterval(autoUpdate, UPDATE_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
log('INFO', 'Monitor', `Auto-update every ${UPDATE_INTERVAL_DAYS} day(s).`);

// --- Resource monitoring ---
function getResources() {
  const load = os.loadavg()[0].toFixed(2);
  const total = (os.totalmem() / 1024 / 1024).toFixed(0);
  const free = (os.freemem() / 1024 / 1024).toFixed(0);
  let disk = 'n/a';
  try {
    const df = execSync('df -k .').toString().split('\n')[1].split(/\s+/);
    const used = (df[2] / 1024 / 1024).toFixed(1);
    const avail = (df[3] / 1024 / 1024).toFixed(1);
    disk = `${used}GiB / ${(used * 1 + avail * 1).toFixed(1)}GiB`;
  } catch (_) { }
  return { load, mem: `${free}MiB / ${total}MiB`, disk };
}

// --- Log tailing ---
function tailLogs() {
  try {
    const data = fs.readFileSync(logFilePath, 'utf-8');
    const lines = data.trim().split('\n');
    return lines.slice(-MAX_LOG_LINES).join('\n');
  } catch (_) {
    return `Cannot read log file: ${LOG_FILE}`;
  }
}

// --- Express dashboard ---
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

function formatDuration(ms) {
  const s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24, d = Math.floor(ms / 86400000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

app.get('/', (req, res) => {
  const now = Date.now();
  const status = isUp ? 'UP' : 'DOWN';
  const since = isUp ? now - lastStartTime : now - (lastExitTime || now);
  const resinfo = getResources();
  const logs = tailLogs().replace(/</g, '&lt;').replace(/>/g, '&gt;');

  res.send(`
<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Bot Dashboard</title>
<style>
 body{font-family:sans-serif;max-width:800px;margin:auto;padding:1rem;}
 .status{font-size:2rem;color:${isUp?'green':'red'};}
 pre{background:#f4f4f4;padding:1rem;overflow:auto;height:200px;}
 table{width:100%;margin:1rem 0;border-collapse:collapse;}
 td,th{border:1px solid #ccc;padding:.5rem;text-align:left;}
</style></head><body>
<h1>🖥️ Bot Health Dashboard</h1>
<p>Status: <span class="status">${status}</span> (${formatDuration(since)})</p>
<p>Auto-Restart: <strong>${autoRestart ? 'ON' : 'OFF'}</strong></p>
<form method="POST" action="/">
 <label><input type="checkbox" name="autoRestart" value="on"
  ${autoRestart ? 'checked' : ''} onchange="this.form.submit()"/> Enable Auto-Restart</label>
</form>
<form method="POST" action="/"><button>🔄 Restart Bot</button></form>
<h2>📊 Resources</h2>
<table><tr><th>Load (1min)</th><td>${resinfo.load}</td></tr>
<tr><th>Memory</th><td>${resinfo.mem}</td></tr>
<tr><th>Disk</th><td>${resinfo.disk}</td></tr></table>
<h2>📝 Recent Logs</h2><pre>${logs}</pre>
</body></html>
  `);
});

// --- Handle POST requests for Restart/Auto-Restart ---
app.post('/', (req, res) => {
  const { autoRestart: autoRestartReq } = req.body;
  autoRestart = autoRestartReq === 'on';
  if (botProcess && isUp) {
    botProcess.kill('SIGTERM');
  } else {
    startBot();
  }
  res.redirect('/');
});

// Start server on localhost
app.listen(PORT, 'localhost', () => {
  log('INFO', 'Monitor', `Server started on http://localhost:${PORT}`);
});
