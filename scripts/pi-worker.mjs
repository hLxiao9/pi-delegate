#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
import { doctorCommand } from '../lib/doctor.mjs';
import { prepareCommand } from '../lib/git-worker.mjs';

process.exitCode = await main(process.argv.slice(2), process, {
  doctor: doctorCommand,
  prepare: prepareCommand,
});
