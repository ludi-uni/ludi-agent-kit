// Render resolved agent models into the pi-subagents settings shape.
// Verified against installed pi-subagents 0.68.0 (docs/models.md, src/agents/agents.ts parseBuiltinOverrideEntry):
//   settings.subagents.agentOverrides.<agentName> = { model: "provider/id", thinking: "<level>" }
// `model` accepts a string; a ":<thinking>" suffix is also accepted, but we emit `thinking` separately
// since that is the documented field. One model per launch — pi-subagents removed `fallbackModels`,
// so fallback is *not* expressible in settings; the kit's escalation runner owns it.
import { formatModelId } from '../../../lib/resolve.mjs';

export const PI_SUBAGENTS_OVERRIDE_KEYS = ['model', 'thinking'];

export function buildSettingsProposal(resolved, { liveSettings = null } = {}) {
  const agentOverrides = {};
  const notes = [];
  for (const [name, r] of Object.entries(resolved)) {
    const primary = r.candidates[0];
    if (!primary) { notes.push(`${name}: no bound model for capability "${r.capability}" (placeholder=${r.placeholder.join(',') || '-'}, unbound=${r.unbound.join(',') || '-'}); left to inherit`); continue; }
    const override = { model: formatModelId(primary, { withThinking: false }) };
    if (primary.thinking) override.thinking = primary.thinking;
    agentOverrides[name] = override;
    if (r.candidates.length > 1) notes.push(`${name}: fallback chain ${r.candidates.slice(1).map(c => c.modelId).join(' -> ')} is handled by the kit runner, not by pi-subagents settings`);
  }
  const proposal = { subagents: { agentOverrides } };
  const diff = [];
  if (liveSettings) {
    const live = liveSettings.subagents?.agentOverrides ?? {};
    for (const [name, o] of Object.entries(agentOverrides)) {
      const cur = live[name];
      if (!cur) diff.push({ agent: name, change: 'add', proposed: o });
      else if (cur.model !== o.model || (cur.thinking ?? null) !== (o.thinking ?? null)) diff.push({ agent: name, change: 'update', live: { model: cur.model, thinking: cur.thinking }, proposed: o });
      else diff.push({ agent: name, change: 'same' });
    }
  }
  return { proposal, notes, diff, target: '~/.pi/agent/settings.json (subagents.agentOverrides) — merge manually or with a future -Apply; never written by the kit' };
}
