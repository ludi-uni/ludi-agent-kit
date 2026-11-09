#!/usr/bin/env node
// No installation hooks. All mutation requires an explicit command AND --apply.
import { diagnosePackage, retireLegacyLink, restoreLegacyLink } from './lib/package-install.mjs';
try {
  const [command = 'doctor', ...args] = process.argv.slice(2);
  const options = {};
  const keys = { 'agent-dir': 'agentDir', 'project-dir': 'projectDir', entry: 'entry', 'expect-target': 'expectTarget', 'backup-id': 'backupId' };
  for (const arg of args) {
    if (arg === '--apply') { options.apply = true; continue; }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !keys[match[1]] || options[keys[match[1]]]) throw new Error(`Unknown/duplicate option: ${arg}`);
    options[keys[match[1]]] = match[2];
  }
  const allowed = { doctor: ['agentDir', 'projectDir'], migrate: ['agentDir', 'entry', 'expectTarget', 'apply'], restore: ['agentDir', 'backupId', 'apply'] };
  if (!allowed[command] || Object.keys(options).some(key => !allowed[command].includes(key))) throw new Error('Usage: package.mjs doctor | migrate --entry=<slot> --expect-target=<absolute path> [--apply] | restore --backup-id=<id> [--apply]; --agent-dir=<dir> supported');
  console.log(JSON.stringify(command === 'doctor' ? diagnosePackage(options) : command === 'migrate' ? retireLegacyLink(options) : restoreLegacyLink(options), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
