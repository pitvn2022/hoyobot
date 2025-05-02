const { spawn, exec, execSync } = require('child_process');
const express    = require('express');
const JSON5      = require('json5');
const fs         = require('fs');
const path       = require('path');
const bodyParser = require('body-parser');
const axios      = require('axios');
const os         = require('os');
const basicAuth  = require('basic-auth');

// --- Load config.json5 ---
const configPath = path.join(__dirname, 'config.json5');
const raw        = fs.readFileSync(configPath, 'utf-8');
const config     = JSON5.parse(raw);

// --- Basic Auth (optional) ---
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

// --- Logging to file + console override ---
const logFilePath = path.join(__dirname, LOG_FILE);
const logStream   = fs.createWriteStream(logFilePath, { flags: 'a' });
const origLog     = console.log;
const origErr     = console.error;
console.log = (...args) => { logStream.write(args.join(' ') + '\n'); origLog(...args); };
console.error = (...args) => { logStream.write(args.join(' ') + '\n'); origErr(...args); };

// --- State & helpers ---
let botProcess, isUp = false, lastStartTime, lastExitTime, autoRestart = false;
let lastNotify = { UP:0, DOWN:0, RESOURCE:0 };

function log(level,module,msg) {
  const ts = new Date().toISOString().replace('T',' ').replace(/\..+$/,'');
  console.log(`${ts} <${level}:${module}> ${msg}`);
}
function logError(module,err) {
  console.error(`${new Date().toISOString().replace('T',' ').replace(/\..+$/,'')} <ERROR:${module}> ${err.stack||err.message}`);
}

async function notifyAll(detail,status){
  const now = Date.now();
  if (now - (lastNotify[status]||0) < THROTTLE_MINUTES*60e3) return;
  lastNotify[status] = now;
  for (const p of config.platforms||[]) {
    if (!p.active) continue;
    try {
      if (p.type==='telegram') {
        await axios.post(`https://api.telegram.org/bot${p.token}/sendMessage`, {
          chat_id: p.chatId,
          text: `*Bot Status: ${status}*\n${detail}`,
          parse_mode:'Markdown',
          disable_notification: p.disableNotification || false,
        });
      } else if (p.type==='webhook') {
        await axios.post(p.url, { embeds:[{
          title: `🤖 Bot Status: ${status}`,
          description: detail,
          color: status==='UP'?0x00FF00:0xFF0000,
          timestamp: new Date().toISOString(),
          footer:{ text:'hoyolab-auto monitor' }
        }]});
      }
    } catch(e){ logError('Notify',e); }
  }
}

// --- Bot lifecycle ---
function startBot(){
  botProcess = spawn('node',['index.js'],{stdio:['ignore','pipe','pipe']});
  isUp = true; lastStartTime = Date.now();
  log('INFO','Monitor',`Bot started (pid ${botProcess.pid})`);
  notifyAll('Bot started','UP');
  botProcess.stdout.on('data', d=>{ process.stdout.write(d); logStream.write(d); });
  botProcess.stderr.on('data', d=>{ process.stderr.write(d); logStream.write(d); });
  botProcess.on('exit',(c,s)=>{
    isUp = false; lastExitTime = Date.now();
    log('WARN','Monitor',`Bot exited code=${c} signal=${s}`);
    notifyAll(`Exit code:${c}, signal:${s}`,'DOWN');
    if (autoRestart) setTimeout(startBot, 5000);
  });
}

// --- Auto-update ---
function autoUpdate(){
  log('INFO','Monitor','Checking updates...');
  exec('git pull',(e,o)=>{
    if(e) return logError('Monitor',e);
    if (!/Already up to date/.test(o)) {
      log('INFO','Monitor',`Pulled:\n${o.trim()}`);
      notifyAll('Code updated','UP');
      if (botProcess && isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}
setInterval(autoUpdate, UPDATE_INTERVAL_DAYS*86400*1000);
log('INFO','Monitor',`Auto-update every ${UPDATE_INTERVAL_DAYS} day(s).`);

// --- System metrics ---
function getResources(){
  const load = os.loadavg()[0].toFixed(2);
  const total = (os.totalmem()/1048576).toFixed(0);
  const free  = (os.freemem()/1048576).toFixed(0);
  let disk='n/a';
  try {
    const df = execSync('df -k .').toString().split('\n')[1].split(/\s+/);
    disk = `${(df[2]/1048576).toFixed(1)}GiB/${((+df[2]+ +df[3])/1048576).toFixed(1)}GiB`;
  } catch {}
  return { load, mem:`${free}MiB/${total}MiB`, disk };
}
function tailLogs(){
  try {
    const d = fs.readFileSync(logFilePath,'utf-8').trim().split('\n');
    return d.slice(-MAX_LOG_LINES).join('\n');
  } catch { return `Cannot read log file`; }
}
function formatDuration(ms){
  let s=Math.floor(ms/1e3)%60, m=Math.floor(ms/6e4)%60,
      h=Math.floor(ms/36e5)%24, d=Math.floor(ms/864e5);
  return [d&&d+'d',h&&h+'h',m&&m+'m',s+'s'].filter(Boolean).join(' ');
}

// --- Web UI ---
const app = express();
app.use(bodyParser.urlencoded({extended:false}));

app.get('/', (req,res)=>{
  const now=Date.now(), status=isUp?'UP':'DOWN';
  const since = isUp? now-lastStartTime : now-(lastExitTime||now);
  const {load,mem,disk}=getResources();
  const logs = tailLogs().replace(/</g,'&lt;');
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Bot Dashboard</title>
<style>body{font-family:sans-serif;max-width:800px;margin:auto;padding:1rem}
.status{color:${isUp?'green':'red'};font-size:1.5rem}
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

app.post('/control/restart', requireAuth, (req,res)=>{
  if(botProcess&&isUp) botProcess.kill('SIGTERM');
  setTimeout(startBot,1000);
  res.redirect(req.headers.referer||'/');
});

app.post('/control/autorestart',(req,res)=>{
  autoRestart = req.body.autoRestart==='on';
  res.redirect(req.headers.referer||'/');
});

app.listen(PORT,'localhost',()=>{
  log('INFO','Monitor',`Server running on http://localhost:${PORT}`);
  startBot();
  autoUpdate();
});
