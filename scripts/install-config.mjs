#!/usr/bin/env node
import { installDefaultConfiguration } from '../lib/config.mjs';
import { serializeError } from '../lib/errors.mjs';

try {
  const result = await installDefaultConfiguration();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(serializeError(error))}\n`);
  process.exitCode = 1;
}
