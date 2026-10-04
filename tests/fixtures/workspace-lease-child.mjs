// IPC-controlled lease holder for cross-process tests; never invokes a model.
import { acquireWorkspaceLease } from '../../lib/orchestrator/workspace-lease.mjs';
const [workspace, lockDir] = process.argv.slice(2);
let lease;
try {
  lease = acquireWorkspaceLease(workspace, { lockDir });
  process.send({ state: 'held', workspace: lease.workspace });
  await new Promise(resolve => process.once('message', resolve));
  lease.release(); lease = null;
  process.send({ state: 'released' });
} catch (error) {
  process.send({ state: 'blocked', code: error.code, error: error.message });
} finally {
  lease?.release();
  process.disconnect();
}
