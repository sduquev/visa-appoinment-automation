const fs = require('fs');
const path = require('path');
const { AISClient } = require('./ais');
const { AppointmentMonitor } = require('./monitor');
const { TelegramBot } = require('./telegram');

const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'config.json');
const statePath = path.join(rootDir, 'state.json');

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const config = loadConfig();
  ensureStateFile();

  const ais = new AISClient({
    ...config.ais,
    currentDate: config.appointment.currentDate,
    currentTime: config.appointment.currentTime,
  }, log);

  const telegram = new TelegramBot(config.telegram, log);
  const monitor = new AppointmentMonitor({
    ais,
    telegram,
    config,
    statePath,
    log,
  });

  process.on('SIGINT', async () => {
    log('Stopping monitor');
    monitor.stop();
    await ais.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('Stopping monitor');
    monitor.stop();
    await ais.stop();
    process.exit(0);
  });

  await ais.start();
  log('Monitor started');
  monitor.start();
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error('config.json not found. Create it from the README example.');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const required = [
    ['ais.email', config.ais && config.ais.email],
    ['ais.password', config.ais && config.ais.password],
    ['ais.loginUrl', config.ais && config.ais.loginUrl],
    ['telegram.botToken', config.telegram && config.telegram.botToken],
    ['telegram.chatId', config.telegram && config.telegram.chatId],
    ['appointment.currentDate', config.appointment && config.appointment.currentDate],
    ['appointment.currentTime', config.appointment && config.appointment.currentTime],
    ['appointment.city', config.appointment && config.appointment.city],
    ['appointment.visaType', config.appointment && config.appointment.visaType],
  ];

  const missing = required
    .filter(([, value]) => !value || String(value).startsWith('TU_'))
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing config values: ${missing.join(', ')}`);
  }
}

function ensureStateFile() {
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, `${JSON.stringify({ lastNotification: null }, null, 2)}\n`);
  }
}

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] ${message}`);
}
