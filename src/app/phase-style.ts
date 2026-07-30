/**
 * Visual mapping for audit lifecycle phases.
 *
 * Shared by the Command Center and the Activity Log so "attempted" and "succeeded" are
 * styled identically in both places — the distinction CLAUDE.md §3 requires is only
 * useful if it looks the same everywhere.
 */
import type { TimelinePhase } from "../lib/audit/log.ts";

export const PHASE_TONE: Record<
  TimelinePhase,
  "proposed" | "approved" | "attempted" | "succeeded" | "failed"
> = {
  proposed: "proposed",
  approved: "approved",
  attempted: "attempted",
  succeeded: "succeeded",
  failed: "failed",
};

const LABELS: Record<TimelinePhase, string> = {
  proposed: "Proposed",
  approved: "Approved",
  attempted: "Attempted",
  succeeded: "Succeeded",
  failed: "Failed",
};

export function phaseLabel(phase: TimelinePhase): string {
  return LABELS[phase];
}
