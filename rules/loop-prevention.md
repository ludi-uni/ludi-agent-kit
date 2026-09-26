## Progress rule — all models

- Reuse facts and tool results already obtained. Do not rerun the same search or
  command unless the input state changed or there is a specific reason to retry.
- If two attempts add no evidence, summarize what is known and unknown, then change
  the hypothesis, narrow the investigation, or report the limitation to the user.
  Do not cycle through equivalent queries or assume a requested feature already exists.
- After the same error recurs, identify a changed precondition before retrying.
  For intentional polling, use bounded waits and an explicit stopping condition.
- Stop when the requested acceptance checks pass. Do not repeat successful checks
  without a relevant change or unresolved issue.
- The runtime guard stops after three identical results from the same tool and input
  within twelve completed results. On a guard stop, wait for new user direction;
  do not automatically resume, delegate the same loop, or evade it by rewording calls.
- These rules apply to every provider/model, including main and delegated agents.
