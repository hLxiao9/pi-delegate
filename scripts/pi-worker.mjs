#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
import { doctorCommand } from '../lib/doctor.mjs';
import { prepareCommand } from '../lib/git-worker.mjs';
import { cleanupCommand, integrateCommand } from '../lib/integration.mjs';
import { reviseCommand, runCommand } from '../lib/pi-runner.mjs';
import { reportCommand } from '../lib/report.mjs';
import { approveCommand } from '../lib/review.mjs';
import { verifyCommand } from '../lib/verification.mjs';

process.exitCode = await main(process.argv.slice(2), process, {
  doctor: doctorCommand,
  prepare: prepareCommand,
  run: runCommand,
  revise: reviseCommand,
  verify: verifyCommand,
  approve: approveCommand,
  integrate: integrateCommand,
  report: reportCommand,
  cleanup: cleanupCommand,
});
