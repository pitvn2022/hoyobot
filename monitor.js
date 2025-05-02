// monitor.js
const { spawn, exec, execSync } = require('child_process');
const express    = require('express');
const JSON5      = require('json5');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const os         = require('os');
const basicAuth  = require('basic-auth');

// --- Load config.json5 ---
const configPath = path.join(__dirname, 'config.json5');
const raw        = fs.readFileSync(configPath, 'utf-8');
const config     = JSON5.parse(raw);

// --- Basic Auth for restart ---
const AUTH = config.health?.auth || { user: 'admin', pass: 'password' };
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== AUTH.user || creds.pass !== AUTH.pass) {
    res.set('WWW-Authenticate', 'Basic realm="Monitor"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// --- Settings ---
const PORT                 = config.health?.port || 3001;
const UPDATE_INTERVAL_DAYS = config.health?.updateIntervalDays ?? 1;
const THROTTLE_MINUTES     = config.health?.throttleMinutes ?? 10;
const LOG_FILE             = config.health?.logFile || 'hoyobot.log';
const MAX_LOG_LINES        = config.health?.maxLogLines || 100;

// --- Override console to also write to log file ---
const logFilePath = path.join(__dirname, LOG_FILE);
const logStream   = fs.createWriteStream(logFilePath, { flags: 'a' });
const origLog     = console.log;
const origErr     = console.error;
console.log = (...args) => { logStream.write(args.join(' ') + '\n'); origLog(...args); };
console.error = (...args) => { logStream.write(args.join(' ') + '\n'); origErr(...args); };

// --- State ---
let botProcess, isUp = false, lastStartTime, lastExitTime, autoRestart = false;
let lastNotify = { UP: 0, DOWN: 0, RESOURCE: 0 };

// --- Logger helpers ---
function log(level, moduleName, msg) {
  const ts = new Date().toISOString().replace('T',' ').replace(/\..+$/,'');
  console.log(`${ts} <${level}:${moduleName}> ${msg}`);
}
function logError(moduleName, err) {
  console.error(`${new Date().toISOString().replace('T',' ').replace(/\..+$/,'')} <ERROR:${moduleName}> ${err.stack || err.message}`);
}

// --- Notification helper w/ throttling ---
async function notifyAll(detail, status) {
  const now = Date.now();
  if (now - (lastNotify[status]||0) < THROTTLE_MINUTES * 60e3) return;
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
        await axios.post(p.url, { embeds: [{
          title: `🤖 Bot Status: ${status}`,
          description: detail,
          color: status === 'UP' ? 0x00FF00 : 0xFF0000,
          timestamp: new Date().toISOString(),
          footer: { text: 'hoyolab-auto monitor' }
        }]});
      }
    } catch (e) {
      logError('Notify', e);
    }
  }
}

// --- Bot lifecycle ---
function startBot() {
  botProcess = spawn('node', ['index.js'], { stdio: ['ignore','pipe','pipe'] });
  isUp = true;
  lastStartTime = Date.now();
  log('INFO', 'Monitor', `Bot started (pid ${botProcess.pid})`);
  notifyAll('Bot started','UP');
  botProcess.stdout.on('data', d => { process.stdout.write(d); logStream.write(d); });
  botProcess.stderr.on('data', d => { process.stderr.write(d); logStream.write(d); });
  botProcess.on('exit', (code, signal) => {
    isUp = false;
    lastExitTime = Date.now();
    log('WARN', 'Monitor', `Bot exited code=${code} signal=${signal}`);
    notifyAll(`Exit code: ${code}, signal: ${signal}`, 'DOWN');
    if (autoRestart) setTimeout(startBot, 5000);
  });
  botProcess.on('error', err => {
    isUp = false;
    lastExitTime = Date.now();
    logError('Monitor', err);
    notifyAll(`Error: ${err.message}`, 'DOWN');
  });
}

// --- Auto-update daily ---
function autoUpdate() {
  log('INFO', 'Monitor', 'Checking for updates...');
  exec('git pull', (err, stdout) => {
    if (err) return logError('Monitor', err);
    if (!/Already up to date/.test(stdout)) {
      log('INFO', 'Monitor', `Pulled:\n${stdout.trim()}`);
      notifyAll('Code updated','UP');
      if (botProcess && isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}
setInterval(autoUpdate, UPDATE_INTERVAL_DAYS * 86400 * 1000);
log('INFO', 'Monitor', `Auto-update every ${UPDATE_INTERVAL_DAYS} day(s).`);

// --- Resource monitoring ---
function getResources() {
  const load  = os.loadavg()[0].toFixed(2);
  const total = (os.totalmem()/1048576).toFixed(0);
  const free  = (os.freemem()/1048576).toFixed(0);
  let disk = 'n/a';
  try {
    const df = execSync('df -k .').toString().split('\n')[1].split(/\s+/);
    disk = `${(df[2]/1048576).toFixed(1)}GiB / ${((+df[2]+ +df[3])/1048576).toFixed(1)}GiB`;
  } catch {}
  return { load, mem:`${free}MiB / ${total}MiB`, disk };
}

// --- Log tailing ---
function tailLogs() {
  try {
    const lines = fs.readFileSync(logFilePath, 'utf-8').trim().split('\n');
    return lines.slice(-MAX_LOG_LINES).join('\n');
  } catch {
    return `Cannot read log file: ${LOG_FILE}`;
  }
}

// --- Helpers ---
function formatDuration(ms) {
  const s = Math.floor(ms/1000)%60,
        m = Math.floor(ms/60000)%60,
        h = Math.floor(ms/3600000)%24,
        d = Math.floor(ms/86400000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// --- Express app & router ---
const app = express();
app.use(express.urlencoded({ extended: false }));

const router = express.Router();

// Dashboard view
router.get('/', (req, res) => {
  const now    = Date.now();
  const status = isUp ? 'UP' : 'DOWN';
  const since  = isUp ? now - lastStartTime : now - (lastExitTime || now);
  const { load, mem, disk } = getResources();
  const logs  = tailLogs().replace(/</g, '&lt;').replace(/>/g, '&gt;');

  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Bot Dashboard</title><style>
body{font-family:sans-serif;max-width:800px;margin:auto;padding:1rem}
.status{color:${status==='UP'?'green':'red'};font-size:1.5rem}
pre{background:#eee;padding:1rem;overflow:auto;height:200px}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #ccc;padding:.5rem;text-align:left}
</style></head><body>
<h1>🤖 Bot Monitor</h1>
<p>Status: <span class="status">${status}</span> (${formatDuration(since)})</p>
<p>Auto-Restart: <strong>${autoRestart?'ON':'OFF'}</strong></p>
<form method="POST" action="control/autorestart">
  <label><input type="checkbox" name="autoRestart" value="on"
    ${autoRestart?'checked':''} onchange="this.form.submit()"> Enable Auto-Restart</label>
</form>
<form method="POST" action="control/restart"><button>🔄 Restart Bot</button></form>
<h2>📊 Resources</h2>
<table>
  <tr><th>CPU Load</th><td>${load}</td></tr>
  <tr><th>Memory</th><td>${mem}</td></tr>
  <tr><th>Disk</th><td>${disk}</td></tr>
</table>
<h2>📝 Logs</h2><pre>${logs}</pre>
</body></html>`);
});

// Restart endpoint
router.post('/control/restart', requireAuth, (req, res) => {
  if (botProcess && isUp) botProcess.kill('SIGTERM');
  setTimeout(startBot, 1000);
  res.redirect(req.headers.referer || '.');
});

// Auto-restart toggle
router.post('/control/autorestart', (req, res) => {
  autoRestart = req.body.autoRestart === 'on';
  log('INFO', 'Monitor', `Auto-Restart → ${autoRestart}`);
  res.redirect(req.headers.referer || '.');
});

// Mount under /proxy.php
app.use('/proxy.php', router);

// Listen on localhost so Apache/Nginx can proxy_pass
app.listen(PORT, 'localhost', () => {
  log('INFO','Monitor',`Server listening on http://localhost:${PORT}`);
  startBot();
  autoUpdate();
});
