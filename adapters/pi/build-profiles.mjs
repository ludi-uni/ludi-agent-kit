// Explicit release/source build. Never invoked by npm lifecycle or Pi startup.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentProfiles } from './lib/agent-profiles.mjs';
const adapter = dirname(fileURLToPath(import.meta.url));
const outDir = join(adapter, 'generated', 'agent-profiles');
if (process.argv.slice(2).some(a => a !== '--check')) throw new Error('Usage: node adapters/pi/build-profiles.mjs [--check]');
if (process.argv.includes('--check')) {
  const { deriveProfile, renderProfileShellGate } = await import('./lib/agent-profiles.mjs');
  const { parseFrontmatter } = await import('../../lib/agents.mjs');
  const expected = [];
  for (const file of readdirSync(resolve(adapter, '../../agents')).filter(f => f.endsWith('.md') && f !== 'README.md').sort()) {
    const profile = deriveProfile({ ...parseFrontmatter(readFileSync(resolve(adapter, '../../agents', file), 'utf8')), file });
    expected.push(file);
    if (readFileSync(join(outDir, file), 'utf8') !== profile.text) throw new Error(`Stale profile: ${file}`);
    if (profile.extensionFileName) {
      const extension = join('extensions', profile.extensionFileName);
      expected.push(extension);
      if (readFileSync(join(outDir, extension), 'utf8') !== renderProfileShellGate({ agent: profile.agent, ...profile.access })) throw new Error(`Stale provider: ${extension}`);
    }
  }
  const actual = readdirSync(outDir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(outDir.length + 1)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) throw new Error('Unexpected generated profile files');
  console.log('Pi profiles are current');
} else {
  const records = renderAgentProfiles({ agentsDir: resolve(adapter, '../../agents'), outDir });
  console.log(`Generated ${records.length} Pi profiles`);
}
