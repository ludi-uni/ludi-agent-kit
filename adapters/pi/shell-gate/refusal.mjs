// Keep refusal guidance executable as a protocol example, not an ambiguous command-only request.
export function formatShellRefusal(command, decision) {
  const result = {
    status: 'needs_decision',
    summary: decision.reason,
    decisions: [{
      question: `コマンド ${JSON.stringify(command)} がshell policyで拒否されました。親は必要性と許可された対応方法を判断してください。`,
      command,
      reason: decision.reason,
      ...(decision.flags?.length ? { flags: decision.flags } : {}),
    }],
  };
  return `POLICY_BLOCK ${decision.reason}. Do not run or retry this command or bypass the policy. Include the following decision request in your final JSON result, preserving the non-empty question and any flags. This is a request for parent review, not permission to execute the command.\n${JSON.stringify(result)}`;
}
