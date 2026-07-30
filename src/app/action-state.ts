/**
 * Shared form-action state.
 *
 * Lives in its own module because a `"use server"` file may only export async functions.
 * Exporting the `IDLE` constant from `actions.ts` violated that rule and made every page
 * using a form fail to render with:
 *
 *   A "use server" file can only export async functions, found object.
 *
 * Types are erased at build time so they would have been fine, but the runtime constant is
 * not — hence a plain module both the server actions and the client components can import.
 */
export interface ActionState {
  status: "idle" | "success" | "error";
  message?: string;
  /** Stable machine-readable code, shown beneath error messages. */
  code?: string;
}

export const IDLE: ActionState = { status: "idle" };
