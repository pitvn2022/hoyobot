const { spawn, exec, execSync } = require('child_process');
const express       = require('express');
const JSON5         = require('json5');
const fs            = require('fs');
const path          = require('path');
const bodyParser    = require('body-parser');
const axios         = require('axios');
const os            = require('os');
const basicAuth     = require('basic-auth');

const configPath = path.join(__dirname, 'config.json5');
const raw        = fs.readFileSync(configPath, 'utf-8');
const config     = JSON5.parse(raw);

const AUTH = config.health?.auth || { user: 'admin', pass: 'password' };
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== AUTH.user || creds.pass !== AUTH.pass) {
    res.set('WWW-Authenticate', 'Basic realm="Monitor"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

const PORT                  = config.health?.port || 3001;
const UPDATE_INTERVAL_DAYS  = config.health?.updateIntervalDays ?? 1;
const THROTTLE_MINUTES      = config.health?.throttleMinutes ?? 10;
const LOG_FILE              = config.health?.logFile || 'hoyobot.log';
const MAX_LOG_LINES         = config.health?.maxLogLines || 100;

const logFilePath = path.join(__dirname, LOG_FILE);
const logStream   = fs.createWriteStream(logFilePath, { flags: 'a' });
const origLog     = console.log;
const origErr     = console.error;
console.log = function(...args) {
  const msg = args.join(' ') + '\n';
  logStream.write(msg);
  origLog.apply(console, args);
};
console.error = function(...args) {
  const msg = args.join(' ') + '\n';
  logStream.write(msg);
  origErr.apply(console, args);
};

let botProcess     = null;
let isUp           = false;
let lastStartTime  = null;
let lastExitTime   = null;
let autoRestart    = false;
let lastNotify     = { UP:0, DOWN:0, RESOURCE:0 };

function log(level,moduleName,msg){
  const ts = new Date().toISOString().replace('T',' ').replace(/\..+$/,'');
  console.log(`${ts} <${level}:${moduleName}> ${msg}`);
}
function logError(moduleName,err){
  console.error(`${new Date().toISOString().replace('T',' ').replace(/\..+$/,'')} <ERROR:${moduleName}> ${err.stack||err.message||err}`);
}

async function notifyAll(detail,status){
  const now = Date.now();
  if (now - (lastNotify[status]||0) < THROTTLE_MINUTES*60e3) return;
  lastNotify[status] = now;
  for(const p of config.platforms||[]){
    if (!p.active) continue;
    try {
      if (p.type==='telegram' && p.token && p.chatId) {
        await axios.post(`https://api.telegram.org/bot${p.token}/sendMessage`, {
          chat_id: p.chatId,
          text: `*Bot Status: ${status}*\n${detail}`,
          parse_mode:'Markdown',
          disable_notification:p.disableNotification||false,
        });
      }
      else if (p.type==='webhook' && p.url) {
        const embed = {
          title: `🤖 Bot Status: ${status}`,
          description: detail,
          color: status==='UP'?0x00FF00:0xFF0000,
          timestamp: new Date().toISOString(),
          footer:{ text:'hoyolab-auto monitor' }
        };
        await axios.post(p.url,{ embeds:[embed] });
      }
    } catch(e){ logError('Monitor',e); }
  }
}

function startBot(){
  botProcess = spawn('node',['index.js'], { stdio: ['ignore','pipe','pipe'] });
  isUp = true;
  lastStartTime = Date.now();
  log('INFO','Monitor',`Bot started (pid ${botProcess.pid})`);
  notifyAll('Bot has started successfully.','UP').catch(e=>logError('Monitor',e));
  botProcess.stdout.on('data', data => { process.stdout.write(data); logStream.write(data); });
  botProcess.stderr.on('data', data => { process.stderr.write(data); logStream.write(data); });
  botProcess.on('exit',(code,signal)=>{
    isUp=false; lastExitTime=Date.now();
    log('WARN','Monitor',`Bot exited code=${code} signal=${signal}`);
    notifyAll(`Exit code: ${code}, signal: ${signal}`,'DOWN').catch(e=>logError('Monitor',e));
    if(autoRestart){
      log('INFO','Monitor','Auto-restart in 5s...');
      setTimeout(() => {
        startBot();
        notifyAll('♻️ Auto-restarted.','UP').catch(e=>logError('Monitor',e));
      },5000);
    }
  });
  botProcess.on('error',err=>{
    isUp=false; lastExitTime=Date.now();
    logError('Monitor',err);
    notifyAll(`Error: ${err.message}`,'DOWN').catch(e=>logError('Monitor',e));
  });
}

function autoUpdate(){
  log('INFO','Monitor','Checking for updates (git pull)...');
  exec('git pull',(err,stdout)=>{
    if(err){ logError('Monitor',err); return; }
    if(/Already up to date\./.test(stdout)){
      log('INFO','Monitor','No updates.');
    } else {
      log('INFO','Monitor',`Pulled:\n${stdout.trim()}`);
      notifyAll('🚀 New code pulled, restarting...','UP');
      if(botProcess&&isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}
setInterval(autoUpdate, UPDATE_INTERVAL_DAYS*24*60*60*1000);
log('INFO','Monitor',`Auto-update every ${UPDATE_INTERVAL_DAYS} day(s).`);

function getResources(){
  const load  = os.loadavg()[0].toFixed(2);
  const total = (os.totalmem()/1024/1024).toFixed(0);
  const free  = (os.freemem()/1024/1024).toFixed(0);
  let disk = 'n/a';
  try {
    const df = execSync('df -k .').toString().split('\n')[1].split(/\s+/);
    disk = `${(df[2]/1024/1024).toFixed(1)}GiB / ${((+df[2]+ +df[3])/1024/1024).toFixed(1)}GiB`;
  } catch(_) {}
  if(Date.now()-lastNotify.RESOURCE>THROTTLE_MINUTES*60e3){
    if(free/total<0.1){
      notifyAll(`Low memory: ${free}MiB free of ${total}MiB`,'RESOURCE');
      lastNotify.RESOURCE=Date.now();
    }
  }
  return { load, mem:`${free}MiB / ${total}MiB`, disk };
}

function tailLogs(){
  try {
    const data = fs.readFileSync(logFilePath,'utf-8');
    return data.trim().split('\n').slice(-MAX_LOG_LINES).join('\n');
  } catch(_) {
    return `Cannot read log file: ${LOG_FILE}`;
  }
}

const app = express();
app.use(bodyParser.urlencoded({ extended:false }));

function formatDuration(ms){
  const s=Math.floor(ms/1000)%60, m=Math.floor(ms/60000)%60;
  const h=Math.floor(ms/3600000)%24, d=Math.floor(ms/86400000);
  return [d&&`${d}d`, h&&`${h}h`, m&&`${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// Main route (catch-all for proxy base URL)
app.get('*', (req, res) => {
  const base = req.baseUrl || '';
  const now = Date.now();
  const status = isUp ? 'UP' : 'DOWN';
  const since = isUp ? now - lastStartTime : now - (lastExitTime || now);
  const resinfo = getResources();
  const logs = tailLogs().replace(/</g, '&lt;').replace(/>/g, '&gt;');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Bot Dashboard</title><style>
body{font-family:sans-serif;max-width:800px;margin:auto;padding:1rem;}
.status{font-size:2rem;color:${isUp ? 'green' : 'red'};}
pre{background:#f4f4f4;padding:1rem;overflow:auto;height:200px;}
table{width:100%;margin:1rem 0;border-collapse:collapse;}
td,th{border:1px solid #ccc;padding:.5rem;text-align:left;}
</style></head><body>
<h1>🖥️ Bot Health Dashboard</h1>
<p>Status: <span class="status">${status}</span> (${formatDuration(since)})</p>
<p>Auto-Restart: <strong>${autoRestart ? 'ON' : 'OFF'}</strong></p>
<form method="POST" action="${base}/control/autorestart">
  <label><input type="checkbox" name="autoRestart" value="on"
    ${autoRestart ? 'checked' : ''} onchange="this.form.submit()"/> Enable Auto-Restart</label>
</form>
<form method="POST" action="${base}/control/restart">
  <button>🔄 Restart Bot</button>
</form>
<h2>📊 Resources</h2>
<table>
  <tr><th>Load (1m)</th><td>${resinfo.load}</td></tr>
  <tr><th>Memory</th><td>${resinfo.mem}</td></tr>
  <tr><th>Disk</th><td>${resinfo.disk}</td></tr>
</table>
<h2>📝 Recent Logs (last ${MAX_LOG_LINES} lines)</h2>
<pre>${logs}</pre>
</body></html>`);
});

app.post('*/control/restart', requireAuth, (req, res) => {
  if (botProcess && isUp) {
    notifyAll('⚠️ Manual restart', 'DOWN');
    botProcess.kill('SIGTERM');
  }
  setTimeout(() => {
    startBot();
    notifyAll('🔄 Manually restarted', 'UP');
  }, 1000);
  res.redirect(req.baseUrl || '/');
});

app.post('*/control/autorestart', (req, res) => {
  autoRestart = req.body.autoRestart === 'on';
  log('INFO', 'Monitor', `Auto-Restart → ${autoRestart}`);
  res.redirect(req.baseUrl || '/');
});

app.listen(PORT, () => {
  log('INFO', 'Monitor', `Server listening on :${PORT}`);
  startBot();
  autoUpdate();
});
