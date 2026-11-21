// ── Compact service · index.ts (thin shell · C5 local-runtime convergence) ──
// Moved into @tricompany/local-runtime/compact (single source; neutral symbol names).
// Forwarding shell keeps every existing relative import path unchanged.
export * from '@tricompany/local-runtime/compact';
// Historical alias kept for consumers (C5 alias-transition form; clean-up after usage-zero).
export type { CompactMessage as TriLCMessage } from '@tricompany/local-runtime/compact';
