#!/usr/bin/env node
/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { main } from '../lib/cli.mjs';
import { dashboardCommand, inspectCommand, listCommand } from '../lib/dashboard.mjs';
import { doctorCommand } from '../lib/doctor.mjs';
import { initCommand } from '../lib/init.mjs';
import { prepareCommand } from '../lib/git-worker.mjs';
import { cleanupCommand, integrateCommand } from '../lib/integration.mjs';
import { reviseCommand, runCommand } from '../lib/pi-runner.mjs';
import { reportCommand } from '../lib/report.mjs';
import { selfReviewCommand } from '../lib/self-review.mjs';
import { serveCommand } from '../lib/server.mjs';
import { approveCommand } from '../lib/review.mjs';
import { recoverCommand } from '../lib/recovery.mjs';
import { verifyCommand } from '../lib/verification.mjs';
import { abortActiveProcesses } from '../lib/process.mjs';

let lastSignal = null;
const signalSensitiveCommands = new Set(['run', 'revise', 'verify', 'self-review']);
if (signalSensitiveCommands.has(process.argv[2])) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      lastSignal = signal;
      abortActiveProcesses(signal);
    });
  }
}

process.exitCode = await main(process.argv.slice(2), process, {
  init: initCommand,
  doctor: doctorCommand,
  prepare: prepareCommand,
  run: runCommand,
  revise: reviseCommand,
  verify: verifyCommand,
  'self-review': selfReviewCommand,
  recover: recoverCommand,
  approve: approveCommand,
  integrate: integrateCommand,
  report: reportCommand,
  cleanup: cleanupCommand,
  list: listCommand,
  inspect: inspectCommand,
  dashboard: dashboardCommand,
  serve: serveCommand,
});

// If a signal arrived while no child process was active, preserve the usual
// shell exit convention after the current command has finished its atomic
// state update.
if (lastSignal && process.exitCode === 0) process.exitCode = lastSignal === 'SIGINT' ? 130 : 143;
