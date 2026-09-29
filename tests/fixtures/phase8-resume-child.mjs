import { openStore } from '../../lib/orchestrator/store.mjs';
import { orchestrate } from '../../lib/orchestrator/orchestrator.mjs';
import { agents, routing, registry, policy, createFixtureRunner } from './phase8-runtime.mjs';
const [db, runId, repo] = process.argv.slice(2);
const session = openStore(db);
try {
  const result = await orchestrate({ request: '', resumeRunId: runId, agents, routing, registry, policy, session,
    repoRoot: repo, runner: createFixtureRunner(repo) });
  console.log(JSON.stringify({ status: result.status, runStatus: result.runStatus, runId: result.runId,
    tasks: result.tasks.length, findings: result.reviewFindings?.length, planDiffs: result.planDiffs?.length }));
} finally { session.close(); }
