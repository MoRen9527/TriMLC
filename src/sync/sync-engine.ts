// ── Sync engine (thin shell · C5 local-runtime convergence) ──
// Moved into @tricompany/local-runtime/sync (single source; neutral symbol syncSession).
// Historical alias kept for consumers (clean-up after usage-zero).
export * from '@tricompany/local-runtime/sync';
export { syncSession as syncSessionToTriMC } from '@tricompany/local-runtime/sync';
