// Codex-only native hook output. Campaign mutations remain in the existing core.
import { createHash } from 'node:crypto';

export const CONTEXT_TOOL = {
  name: 'campaign_context_hook',
  description: 'Read-only callback for native Codex campaign reminder hooks. Uses only the host thread binding; never selects or advances a campaign.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      event: { type: 'string', enum: ['SessionStart', 'PostToolUse', 'UserPromptSubmit'] },
      source: { type: 'string' },
    }, required: ['event'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const terminal = new Set(['CLOSED', 'CLOSED_QUALIFIED', 'ABORTED']);
const events = new Set(['SessionStart', 'PostToolUse', 'UserPromptSubmit']);
const shorten = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text;
};

export function renderReminder(status) {
  if (!status || terminal.has(status.lifecycle) ||
      !['campaign_id', 'version', 'objective', 'lifecycle'].every(k => status[k] !== undefined && status[k] !== null)) return null;
  const packages = status.work_packages ?? [];
  const finished = ['ACCEPTED', 'CANCELLED', 'SUPERSEDED'];
  const counts = finished.map(name => packages.filter(p => p.status === name).length);
  const outstanding = packages.filter(p => !finished.includes(p.status));
  const gates = (status.gates ?? []).filter(g => g.status === 'OPEN');
  const list = (items, describe) => items.slice(0, 5).map(describe).join(', ') +
    (items.length > 5 ? ` (+${items.length - 5} more)` : '') || 'none';
  const text = [
    '[Campaign checkpoint: read-only advisory; current bound campaign]',
    `Campaign: ${status.campaign_id} v${status.version}`,
    `Objective: ${shorten(status.objective, 200)}`,
    `Lifecycle: ${status.lifecycle}; phase: ${shorten(status.phase ?? 'unknown', 60)}`,
    `${counts[0]} accepted; ${counts[1]} cancelled; ${counts[2]} superseded`,
    `Outstanding: ${outstanding.length}: ` + list(outstanding, p => `${shorten(p.package_id, 40)} (${shorten(p.status, 20)})`),
    `Open gates: ${gates.length}: ` + list(gates, g => shorten(g.gate_id, 45)),
    'Next permitted actions: ' + list(status.next_permitted_actions ?? [], a => shorten(a, 45)),
    "Latest owner instructions control steering and cancellation. This replaces earlier reminder state; it does not advance progress.",
  ].join('\n');
  return text.length <= 2000 ? text : null;
}

function output(event, text) {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
}

export function contextHook(store, state, args, threadId, bindingToken) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !events.has(args.event) ||
      Object.keys(args).some(k => !['event', 'source'].includes(k))) return {};
  const event = args.event;
  if (event === 'SessionStart' && args.source !== 'compact') return {};
  const invalidate = reason => {
    const hadContext = Boolean(state.digest);
    Object.assign(state, { active: false, key: null, digest: null });
    return output(event, hadContext ? '[Campaign reminder cleared]\n' + reason +
      ' Earlier campaign reminders do not authorize work. Explicit binding is required.' : null);
  };
  const binding = store.binding;
  if (!binding) return invalidate('This thread is unbound.');
  if (binding.thread_id !== threadId || !bindingToken) return invalidate('The current binding identity is unavailable.');
  const key = JSON.stringify([binding.campaign_id, binding.run_id, bindingToken]);
  if (state.key !== key) {
    const cleared = invalidate('The campaign binding changed.');
    state.key = key;
    if (event !== 'SessionStart') return cleared;
  }
  if (event === 'SessionStart') { state.active = true; state.digest = null; }
  if (!state.active) return {};
  try {
    const status = store.status();
    if (status.campaign_id !== binding.campaign_id || status.bound_run?.thread_id !== threadId)
      return invalidate('The campaign binding identity could not be verified.');
    if (terminal.has(status.lifecycle)) return invalidate('The bound campaign is terminal.');
    const text = renderReminder(status);
    if (!text) return invalidate('A bounded current reminder is unavailable.');
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest === state.digest) return {};
    state.digest = digest;
    return output(event, text);
  } catch {
    return invalidate('Current campaign state could not be read.');
  }
}
