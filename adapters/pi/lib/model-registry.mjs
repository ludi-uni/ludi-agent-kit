// Pi's durable model bindings live in the user agent directory, outside the npm package.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../../../lib/registry.mjs';

export function piUserModelsPath(env = process.env, home = homedir()) {
  return join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'ludi-agent-kit', 'models.local.json');
}

export function loadPiRegistry(kit, routing, { env = process.env, home = homedir() } = {}) {
  return loadRegistry(join(kit, 'adapters/pi/models.json'), join(kit, 'adapters/pi/models.local.json'), routing, piUserModelsPath(env, home));
}
