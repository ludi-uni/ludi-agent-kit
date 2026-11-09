// Test-only agent fixtures: decouple mechanism tests (candidate order, retry,
// capability escalation) from the SHIPPED agents/*.md capability defaults.
// The shipped defaults stay pinned by kit.test.mjs fixed-value comparisons and
// by a small set of shipped-config integration assertions in each consumer —
// never blanket-override every role (that would silently mask real regressions
// in agent->capability routing).

/** Deep-clone `agents` and pin `meta.capability` for the named roles only.
 *  An unknown role throws so a renamed/removed shipped agent cannot silently
 *  weaken a test; a capability missing from routing.capabilities throws the
 *  same way. Other roles keep their shipped default. */
export function agentsWithCapabilities(agents, overrides, routing = null) {
  const cloned = structuredClone(agents);
  const byName = new Map(cloned.map(a => [a.meta.name, a]));
  for (const [role, capability] of Object.entries(overrides)) {
    const agent = byName.get(role);
    if (!agent) throw new Error(`agentsWithCapabilities: unknown agent role "${role}" — extend or fix the fixture explicitly`);
    if (routing && !Object.hasOwn(routing.capabilities ?? {}, capability)) {
      throw new Error(`agentsWithCapabilities: capability "${capability}" for role "${role}" is not defined in routing — add a routing fixture instead`);
    }
    agent.meta.capability = capability;
  }
  return cloned;
}
