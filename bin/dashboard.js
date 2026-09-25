#!/usr/bin/env node

const path = require('path');
const { DashboardApplication } = require('../lib/dashboard');

async function main() {
  const startMonitor = !process.argv.includes('--ui-only');
  const options = { startMonitor };
  if (process.argv.includes('--no-open')) options.autoOpen = false;
  const app = new DashboardApplication(path.resolve(__dirname, '..'), options);
  await app.start();
  return app;
}

if (require.main === module) {
  main().catch(error => {
    console.error('[FATAL]', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
};
