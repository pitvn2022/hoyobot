const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const app = express();
const port = 5010;

// Config
const config = require("./config.json5");
const generalWebhook = config.webhooks.find(w => w.role === "general")?.url;
const systemWebhook = config.webhooks.find(w => w.role === "system")?.url;
const versionFile = path.join(__dirname, "version.txt");

// Middleware để parse JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Giao diện UI
app.get("/", (req, res) => {
  const cpuLoad = os.loadavg()[0].toFixed(2);
  const totalMem = (os.totalmem() / 1024 / 1024).toFixed(1);
  const freeMem = (os.freemem() / 1024 / 1024).toFixed(1);
  const usedMem = (totalMem - freeMem).toFixed(1);

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Bot Monitor</title>
    <style>
      body {
        font-family: sans-serif;
        background: #111;
        color: #eee;
        padding: 2em;
      }
      h1 { color: #3fa9f5; }
      button {
        padding: 10px 20px;
        margin: 10px 5px;
        background: #3fa9f5;
        border: none;
        color: #fff;
        cursor: pointer;
        font-size: 1em;
      }
      .stats {
        margin: 1em 0;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <h1>Bot Monitor</h1>
    <div class="stats">
      <div><strong>CPU Load:</strong> ${cpuLoad}</div>
      <div><strong>Memory:</strong> ${usedMem} MiB / ${totalMem} MiB</div>
    </div>
    <form action="/control/restart" method="post">
      <button type="submit">Restart</button>
    </form>
    <form action="/control/update" method="post">
      <button type="submit">Update</button>
    </form>
  </body>
  </html>
  `;
  res.send(html);
});

// Gửi đến Discord webhook
function sendToWebhook(content, isSystem = false) {
  const url = isSystem ? systemWebhook : generalWebhook;
  if (!url) return;
  axios.post(url, { content }).catch(console.error);
}

// Restart
app.post("/control/restart", (req, res) => {
  sendToWebhook("🔁 Bot is restarting...", true);
  res.send("Restarting...");
  setTimeout(() => {
    process.exit(1);
  }, 500);
});

// Update
app.post("/control/update", async (req, res) => {
  sendToWebhook("⬇️ Checking for updates...", true);
  try {
    const { stdout } = await execPromise("git pull");
    if (stdout.includes("Already up to date")) {
      sendToWebhook("✅ Bot is already up to date.", true);
    } else {
      const version = new Date().toISOString();
      fs.writeFileSync(versionFile, version);
      sendToWebhook(`✅ Bot updated to latest version.\nRestarting...`, true);
      setTimeout(() => process.exit(1), 1000);
    }
    res.send("Updated");
  } catch (e) {
    sendToWebhook(`❌ Update failed:\n${e.message}`, true);
    res.status(500).send("Update failed");
  }
});

// Promise wrapper for exec
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

// Tự kiểm tra cập nhật mỗi 24h
setInterval(async () => {
  try {
    const { stdout } = await execPromise("git fetch");
    const { stdout: diff } = await execPromise("git status -uno");
    if (diff.includes("Your branch is behind")) {
      sendToWebhook("🆕 New update available. Updating...", true);
      await execPromise("git pull");
      const version = new Date().toISOString();
      fs.writeFileSync(versionFile, version);
      sendToWebhook("✅ Update applied. Restarting...", true);
      setTimeout(() => process.exit(1), 1000);
    }
  } catch (e) {
    sendToWebhook(`❌ Auto-update failed:\n${e.message}`, true);
  }
}, 24 * 60 * 60 * 1000); // 24h

// Start
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
