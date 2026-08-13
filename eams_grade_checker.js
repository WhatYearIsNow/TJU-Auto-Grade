#!/usr/bin/env node

const app = require('./eams_grade_checker_v2');

if (require.main === module) {
  app.main().catch(error => {
    console.error('[FATAL]', error.message);
    process.exitCode = 1;
  });
}

module.exports = app;
