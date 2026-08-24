// Shared config loader. Single source of truth for config.json + env overrides.
// Both main.js (Electron main process) and proxy.js (Node HTTP server) require this.

const fs = require('fs');
const path = require('path');

const DEFAULTS = { port: 8080 };

function loadConfig(appDir) {
  const configPath = path.join(appDir, 'config.json');
  const config = { ...DEFAULTS };
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (e) {
    // Missing or unreadable config — fall back to defaults silently.
  }
  // Env override wins over config.json
  if (process.env.CC_MONITOR_PORT) {
    config.port = parseInt(process.env.CC_MONITOR_PORT, 10);
  }
  return config;
}

module.exports = { loadConfig, DEFAULTS };
