const fs = require('fs');
const path = require('path');

const PID_FILE = path.resolve(__dirname, '.api-server-pid');

module.exports = async () => {
  try {
    if (!fs.existsSync(PID_FILE)) {
      return;
    }
    const pidStr = fs.readFileSync(PID_FILE, 'utf8');
    const pid = Number(pidStr.trim());
    if (!Number.isNaN(pid)) {
      try {
        process.kill(pid, 'SIGINT');
      } catch (_err) {
        // process may already be gone; ignore
      }
    }
  } catch (_err) {
    // ignore teardown errors
  }
};
