#!/usr/bin/env node
import { runCli } from './core/cli-runner';

void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
