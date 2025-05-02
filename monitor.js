// monitor.js
const { spawn, exec, execSync } = require('child_process');
const express    = require('express');
const JSON5      = require('json5');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const os         = require('os');
const basicAuth  = require('basic-auth');

// --- Load config ---
const configPath = path.join(__dirname, 'config.json5');
const raw        = fs.readFileSync(configPath, 'utf-8');
const config     = JSON5.parse(raw);

// --- Auth ---
const AUTH = config.health?.auth || { user: 'admin', pass: 'password' };
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== AUTH.user || creds.pass !== AUTH.pass) {
    res.set('WWW-Authenticate','Basic realm="Monitor"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// --- Settings ---
const PORT                 = config.health?.port || 5010;
const UPDATE_INTERVAL_DAYS = config.health?.updateIntervalDays ?? 1;
const THROTTLE_MINUTES     = config.health?.throttleMinutes ?? 10;
const LOG_FILE             = config.health?.logFile || 'hoyobot.log';
const MAX_LOG_LINES        = config.health?.maxLogLines || 100;

// --- Logging to file + console override ---
const logFilePath = path.join(__dirname, LOG_FILE);
const logStream   = fs.createWriteStream(logFilePath,{flags:'a'});
const origLog     = console.log;
const origErr     = console.error;
console.log = (...args)=>{ logStream.write(args.join(' ')+'\n'); origLog.apply(console,args); };
console.error = (...args)=>{ logStream.write(args.join(' ')+'\n'); origErr.apply(console,args); };

// --- State ---
let botProcess, isUp=false, lastStartTime, lastExitTime, autoRestart=false;
let lastNotify = { UP:0, DOWN:0, RESOURCE:0 };

// --- Helpers ---
function log(lvl,mod,msg){
  const ts=(new Date()).toISOString().replace('T',' ').replace(/\..+$/,'');
  console.log(`${ts} <${lvl}:${mod}> ${msg}`);
}
function logError(mod,err){
  console.error((new Date()).toISOString().replace('T',' ').replace(/\..+$/,'')+
                ` <ERROR:${mod}> ${err.stack||err.message}`);
}
function getVersion(){
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
}

// --- Notifications w/ throttle ---
async function notifyAll(detail,status){
  const now=Date.now();
  if(now - (lastNotify[status]||0) < THROTTLE_MINUTES*60000) return;
  lastNotify[status]=now;
  for(const p of config.platforms||[]){
    if(!p.active) continue;
    try {
      if(p.type==='telegram'){
        await axios.post(`https://api.telegram.org/bot${p.token}/sendMessage`,{
          chat_id:p.chatId,
          text:`*Bot Status: ${status}*\n${detail}`,
          parse_mode:'Markdown',
          disable_notification:p.disableNotification||false
        });
      } else if(p.type==='webhook'){
        await axios.post(p.url,{embeds:[{
          title:`🤖 Bot Status: ${status}`,
          description:detail,
          color:status==='UP'?0x00FF00:0xFF0000,
          timestamp:new Date().toISOString(),
          footer:{text:'hoyolab-auto monitor'}
        }]});
      }
    } catch(e){ logError('Notify',e); }
  }
}

// --- Bot lifecycle ---
function startBot(){
  botProcess = spawn('node',['index.js'],{stdio:['ignore','pipe','pipe']});
  isUp=true; lastStartTime=Date.now();
  log('INFO','Monitor',`Bot started (pid ${botProcess.pid}), ver ${getVersion()}`);
  notifyAll('Bot started','UP');
  botProcess.stdout.on('data',d=>{ process.stdout.write(d); logStream.write(d); });
  botProcess.stderr.on('data',d=>{ process.stderr.write(d); logStream.write(d); });
  botProcess.on('exit',(c,s)=>{
    isUp=false; lastExitTime=Date.now();
    log('WARN','Monitor',`Bot exited code=${c} signal=${s}`);
    notifyAll(`Exit code:${c}, signal:${s}`,'DOWN');
    if(autoRestart) setTimeout(startBot,5000);
  });
  botProcess.on('error',err=>{
    isUp=false; lastExitTime=Date.now();
    logError('Monitor',err);
    notifyAll(`Error:${err.message}`,'DOWN');
  });
}

// --- Auto-update ---
function autoUpdate(){
  exec('git pull',(err,out)=>{
    if(err) return logError('Monitor',err);
    if(!/Already up to date/.test(out)){
      log('INFO','Monitor',`Pulled:\n${out.trim()}`);
      notifyAll('Code updated','UP');
      if(botProcess&&isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}
setInterval(autoUpdate,UPDATE_INTERVAL_DAYS*86400*1000);
log('INFO','Monitor',`Auto-update every ${UPDATE_INTERVAL_DAYS} day(s).`);

// --- Manual update helper ---
function manualUpdate(){
  exec('git pull',(err,out)=>{
    if(err) return logError('Monitor',err);
    log('INFO','Monitor',`Manual pull:\n${out.trim()}`);
    if(!/Already up to date/.test(out)){
      notifyAll('Manual update','UP');
      if(botProcess&&isUp) botProcess.kill('SIGTERM');
      else startBot();
    }
  });
}

// --- Metrics & logs ---
function getResources(){
  const load=os.loadavg()[0].toFixed(2),
        total=(os.totalmem()/1048576).toFixed(0),
        free=(os.freemem()/1048576).toFixed(0);
  let disk='n/a';
  try{
    const df=execSync('df -k .').toString().split('\n')[1].split(/\s+/);
    disk=`${(df[2]/1048576).toFixed(1)}GiB/${((+df[2]+ +df[3])/1048576).toFixed(1)}GiB`;
  } catch {}
  return {load,mem:`${free}MiB/${total}MiB`,disk};
}
function tailLogs(){
  try { return fs.readFileSync(logFilePath,'utf-8').trim().split('\n').slice(-MAX_LOG_LINES).join('\n'); }
  catch { return 'Cannot read log file'; }
}
function formatDuration(ms){
  const s=Math.floor(ms/1e3)%60,
        m=Math.floor(ms/6e4)%60,
        h=Math.floor(ms/36e5)%24,
        d=Math.floor(ms/864e5);
  return [d&&d+'d',h&&h+'h',m&&m+'m',s+'s'].filter(Boolean).join(' ');
}

// --- Express setup ---
const app = express();
app.use(express.urlencoded({extended:false}));

// Dashboard
app.get('/',(req,res)=>{
  const now=Date.now(), status=isUp?'UP':'DOWN';
  const since=isUp?now-lastStartTime:now-(lastExitTime||now);
  const {load,mem,disk}=getResources();
  const logs=tailLogs().replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const version=getVersion();

  res.send(`<!doctype html>
<html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bot Dashboard</title>
  <style>
    :root {
      --bg: #f5f5f5; --fg:#333;
      --card-bg:#fff; --card-border:#ddd;
      --accent:#0066cc;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg:#1e1e1e; --fg:#ddd;
        --card-bg:#2e2e2e; --card-border:#444;
        --accent:#3399ff;
      }
    }
    body {
      margin:0; padding:1rem;
      font-family:sans-serif; background:var(--bg); color:var(--fg);
    }
    .header {
      display:flex; align-items:center; justify-content:space-between;
    }
    h1 { margin:0; font-size:1.5rem; }
    .card {
      background:var(--card-bg); border:1px solid var(--card-border);
      border-radius:6px; padding:1rem; margin:1rem 0;
      box-shadow:0 2px 4px rgba(0,0,0,0.1);
    }
    .status { font-weight:bold; color: var(--accent);}
    .metrics { display:flex; gap:1rem; flex-wrap:wrap; margin-top:.5rem; }
    .metric {
      flex:1 1 120px; background:var(--bg); padding:.5rem;
      border:1px solid var(--card-border); border-radius:4px;
      text-align:center;
    }
    .metric span { display:block; font-size:1.2rem; }
    .controls button {
      background:var(--accent); color:#fff; border:none; padding:.5rem 1rem;
      margin-right:.5rem; border-radius:4px; cursor:pointer;
    }
    .controls input { margin-right:.3rem; }
    pre {
      background:var(--card-bg); padding:.5rem; overflow:auto;
      max-height:200px; border:1px solid var(--card-border); border-radius:4px;
    }
    @media (max-width:600px) {
      .metrics { flex-direction:column; }
    }
  </style>
</head><body>
  <div class="header">
    <h1>🤖 Bot Monitor (v${version})</h1>
    <div class="controls">
      <form style="display:inline" method="POST" action="/proxy.php/control/autorestart">
        <label><input type="checkbox" name="autoRestart" value="on" ${autoRestart?'checked':''}
          onchange="this.form.submit()">Auto-Restart</label>
      </form>
      <form style="display:inline" method="POST" action="/proxy.php/control/restart">
        <button>🔄 Restart</button>
      </form>
      <form style="display:inline" method="POST" action="/proxy.php/control/update">
        <button>🆕 Update</button>
      </form>
    </div>
  </div>

  <div class="card">
    <div>Status: <span class="status">${status}</span> (${formatDuration(since)})</div>
    <div class="metrics">
      <div class="metric"><label>CPU Load</label><span>${load}</span></div>
      <div class="metric"><label>Memory</label><span>${mem}</span></div>
      <div class="metric"><label>Disk</label><span>${disk}</span></div>
    </div>
  </div>

  <div class="card">
    <strong>Logs (last ${MAX_LOG_LINES} lines):</strong>
    <pre>${logs}</pre>
  </div>
</body></html>`);
});

// Restart endpoint
app.post('/control/restart', requireAuth, (req,res)=>{
  if(botProcess&&isUp) botProcess.kill('SIGTERM');
  setTimeout(startBot,1000);
  res.redirect('/proxy.php');
});

// Auto-restart toggle
app.post('/control/autorestart',(req,res)=>{
  autoRestart = req.body.autoRestart==='on';
  log('INFO','Monitor',`Auto-Restart → ${autoRestart}`);
  res.redirect('/proxy.php');
});

// Update endpoint
app.post('/control/update', requireAuth, (req,res)=>{
  manualUpdate();
  res.redirect('/proxy.php');
});

// Start server on localhost
app.listen(PORT,'localhost',()=>{
  log('INFO','Monitor',`Server listening on http://localhost:${PORT}`);
  startBot();
  autoUpdate();
});
