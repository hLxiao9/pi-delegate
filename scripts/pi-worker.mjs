#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
import { doctorCommand } from '../lib/doctor.mjs';

process.exitCode = await main(process.argv.slice(2), process, {
  doctor: doctorCommand,
});
