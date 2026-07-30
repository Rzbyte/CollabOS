"use client";

/**
 * Client-side form wrappers.
 *
 * These own only presentation and pending/error state. All decision logic lives in the
 * server actions, so nothing here can bypass an approval gate or a state transition.
 */
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { IDLE, type ActionState } from "../app/action-state.ts";
import {
  approveDeliverableAction,
  approveOutreachAction,
  approvePartnerAction,
  cancelCampaignAction,
  rejectDeliverableAction,
  rejectPartnerAction,
  removeFromCircleAction,
  retryAdvanceAction,
  retryRecommendationsAction,
  submitObjectiveAction,
} from "../app/actions.ts";
import {
  acceptCollaborationAction,
  submitDeliverableAction,
} from "../app/collab/actions.ts";

function SubmitButton({
  children,
  variant = "primary",
  pendingLabel,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();

  const styles: Record<string, string> = {
    primary:
      "bg-accent text-accent-ink hover:brightness-110 disabled:opacity-55",
    secondary:
      "border border-edge-strong text-ink hover:bg-surface-raised disabled:opacity-55",
    danger:
      "border border-failed/55 text-failed hover:bg-failed/10 disabled:opacity-55",
  };

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}

function Feedback({ state }: { state: ActionState }) {
  if (state.status === "idle" || !state.message) return null;

  const isError = state.status === "error";

  return (
    <p
      role="status"
      aria-live="polite"
      className={`mt-3 rounded-md border px-3 py-2 text-sm ${
        isError
          ? "border-failed/40 bg-failed/5 text-failed"
          : "border-succeeded/40 bg-succeeded/5 text-succeeded"
      }`}
    >
      {state.message}
      {isError && state.code && (
        <span className="mt-1 block font-mono text-xs opacity-70">{state.code}</span>
      )}
    </p>
  );
}

export function ObjectiveForm() {
  const [state, action] = useActionState(submitObjectiveAction, IDLE);

  return (
    <form action={action}>
      <label
        htmlFor="objective"
        className="block text-sm font-medium text-ink-muted"
      >
        Growth objective
      </label>
      <textarea
        id="objective"
        name="objective"
        rows={3}
        required
        minLength={10}
        maxLength={600}
        defaultValue="Launch a wallet-safety educational video and grow my beginner audience through one collaboration."
        placeholder="e.g. Run a collaboration to grow the launch of my next video."
        className="mt-2 w-full resize-y rounded-lg border border-edge bg-surface-inset px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <p className="mt-2 text-xs text-ink-faint">
        CollabOS loads your brand memory and relationship history, then asks the Mind to
        rank candidates. Nothing is sent to anyone at this step.
      </p>
      <div className="mt-3">
        <SubmitButton pendingLabel="Asking the Mind…">
          Submit objective
        </SubmitButton>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RetryRecommendationsForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState(retryRecommendationsAction, IDLE);

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <SubmitButton variant="secondary" pendingLabel="Retrying…">
        Retry evaluation
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function ApprovePartnerForm({
  campaignId,
  partnerId,
  partnerName,
  disabled,
  disabledReason,
}: {
  campaignId: string;
  partnerId: string;
  partnerName: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, action] = useActionState(approvePartnerAction, IDLE);

  if (disabled) {
    return (
      <div>
        <button
          type="button"
          disabled
          title={disabledReason}
          className="cursor-not-allowed rounded-md border border-edge px-3.5 py-2 text-sm font-medium text-ink-faint opacity-60"
        >
          Approve blocked
        </button>
        {disabledReason && (
          <p className="mt-2 text-xs text-failed">{disabledReason}</p>
        )}
      </div>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="partnerId" value={partnerId} />
      <SubmitButton pendingLabel="Approving…">Approve {partnerName}</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function RejectPartnerForm({
  campaignId,
  partnerId,
}: {
  campaignId: string;
  partnerId: string;
}) {
  const [state, action] = useActionState(rejectPartnerAction, IDLE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="partnerId" value={partnerId} />
      <input
        type="text"
        name="note"
        maxLength={500}
        placeholder="Reason (optional)"
        aria-label="Reason for rejecting this partner"
        className="rounded-md border border-edge bg-surface-inset px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <SubmitButton variant="secondary" pendingLabel="Recording…">
        Reject
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function CancelCampaignForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState(cancelCampaignAction, IDLE);

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <SubmitButton variant="danger" pendingLabel="Cancelling…">
        Cancel campaign
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Creator: outreach + recovery
// ---------------------------------------------------------------------------

export function ApproveOutreachForm({
  campaignId,
  partnerName,
}: {
  campaignId: string;
  partnerName: string;
}) {
  const [state, action] = useActionState(approveOutreachAction, IDLE);

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <p className="mb-3 text-sm text-ink-muted">
        This authorises the <strong>first external contact</strong> with {partnerName}.
        CollabOS will ask the Mind to write it in your voice and deliver it through the
        local test transport.
      </p>
      <SubmitButton pendingLabel="Composing and sending…">
        Approve and send outreach
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function RetryAdvanceForm({
  campaignId,
  label = "Retry setup",
}: {
  campaignId: string;
  label?: string;
}) {
  const [state, action] = useActionState(retryAdvanceAction, IDLE);

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <SubmitButton variant="secondary" pendingLabel="Retrying…">
        {label}
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveFromCircleForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState(removeFromCircleAction, IDLE);

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <SubmitButton variant="danger" pendingLabel="Removing…">
        Remove from Circle
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Creator: final approval
// ---------------------------------------------------------------------------

export function ApproveDeliverableForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState(approveDeliverableAction, IDLE);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="campaignId" value={campaignId} />

      <div>
        <label
          htmlFor="performance"
          className="block text-sm font-medium text-ink-muted"
        >
          Your rating of this collaboration (optional, 0–1)
        </label>
        <input
          id="performance"
          name="performance"
          type="number"
          min={0}
          max={1}
          step={0.01}
          placeholder="e.g. 0.85"
          className="mt-1.5 w-32 rounded-md border border-edge bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        {/* Honesty: CollabOS has no analytics, so this figure can only come from a human. */}
        <p className="mt-1.5 text-xs text-ink-faint">
          Creator-reported only. CollabOS has no analytics integration and will not estimate
          audience growth — leave this blank and it stays unrecorded.
        </p>
      </div>

      <SubmitButton pendingLabel="Completing…">Approve and complete</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function RejectDeliverableForm({ campaignId }: { campaignId: string }) {
  const [state, action] = useActionState(rejectDeliverableAction, IDLE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <label htmlFor="revision-note" className="block text-sm font-medium text-ink-muted">
        What needs changing?
      </label>
      <input
        id="revision-note"
        name="note"
        type="text"
        required
        minLength={3}
        maxLength={500}
        placeholder="Ask for a specific revision"
        className="w-full rounded-md border border-edge bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <SubmitButton variant="secondary" pendingLabel="Requesting…">
        Request revision
      </SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Collaborator: token-authenticated
// ---------------------------------------------------------------------------

export function AcceptCollaborationForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptCollaborationAction, IDLE);

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      <SubmitButton pendingLabel="Accepting…">Accept collaboration</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function SubmitDeliverableForm({ token }: { token: string }) {
  const [state, action] = useActionState(submitDeliverableAction, IDLE);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />

      <div>
        <label
          htmlFor="submissionUrl"
          className="block text-sm font-medium text-ink-muted"
        >
          Link to your deliverable
        </label>
        <input
          id="submissionUrl"
          name="submissionUrl"
          type="text"
          required
          maxLength={2000}
          placeholder="https://… or a file reference"
          className="mt-1.5 w-full rounded-md border border-edge bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="note" className="block text-sm font-medium text-ink-muted">
          Note for the creator (optional)
        </label>
        <textarea
          id="note"
          name="note"
          rows={3}
          maxLength={1000}
          className="mt-1.5 w-full resize-y rounded-md border border-edge bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      </div>

      <SubmitButton pendingLabel="Submitting…">Submit deliverable</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}
