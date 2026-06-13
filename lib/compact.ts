/**
 * Legacy compact initialization - no-op since pi handles compaction directly.
 *
 * This function used to set up aggressive compaction hooks but those have been
 * moved to built-in pi compaction via ctx.compact().
 */

export function initCompact(_pi: any): void {
  // No-op - pi's ctx.compact() handles everything now
}
