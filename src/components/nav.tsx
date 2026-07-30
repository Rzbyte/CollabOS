import Link from "next/link";

import { AutoRefresh } from "./auto-refresh.tsx";
import { Badge } from "./ui.tsx";
import { isFixtureMindEnabled } from "../lib/minds/fixture-port.ts";

export type NavKey = "command" | "partners" | "activity" | "room" | "report";

const LINKS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "command", href: "/", label: "Command Center" },
  { key: "partners", href: "/partners", label: "Partner Review" },
  { key: "room", href: "/room", label: "Collaboration Room" },
  { key: "activity", href: "/activity", label: "Activity Log" },
  { key: "report", href: "/report", label: "Report" },
];

/**
 * Permanent warning while the offline fixture Mind is active.
 *
 * Rendered on every page, deliberately impossible to overlook. A canned Mind response shown
 * without this banner would be exactly the "mocked action presented as real" that §14
 * forbids.
 */
function FixtureMindBanner() {
  if (!isFixtureMindEnabled()) return null;

  return (
    <div
      role="alert"
      className="mb-6 rounded-lg border-2 border-failed bg-failed/15 px-4 py-3"
    >
      <p className="text-sm font-bold text-failed">
        ⚠ OFFLINE FIXTURE MIND ACTIVE — responses below are canned test data
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        No real Mind was contacted and no Circle was mutated. This mode exists only so the
        automated end-to-end test can run without credentials. It is not a valid demo and
        proves nothing about the Minds integration. Unset{" "}
        <code className="font-mono text-xs">COLLABOS_UNSAFE_FIXTURE_MIND</code> to use the
        real platform.
      </p>
    </div>
  );
}

export function Header({ current }: { current: NavKey }) {
  return (
    <header className="mb-8">
      <FixtureMindBanner />
      {/* Every page needs exactly one h1 — this is it. Previously the brand was a bare
          Link, which left these pages with no top-level heading for screen readers. */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          <Link href="/" className="hover:text-accent">
            CollabOS
          </Link>
        </h1>
        <Badge tone="accent">Creator Partnership Director</Badge>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        The creator chooses the relationship. CollabOS runs everything in between.
      </p>

      <nav
        aria-label="Main"
        className="mt-5 flex flex-wrap items-end justify-between gap-3 border-b border-edge"
      >
        <ul className="flex flex-wrap gap-1">
          {LINKS.map((link) => {
            const active = link.key === current;
            return (
              <li key={link.key}>
                <Link
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px inline-block border-b-2 px-3.5 py-2.5 text-sm font-medium transition ${
                    active
                      ? "border-accent text-accent"
                      : "border-transparent text-ink-muted hover:border-edge-strong hover:text-ink"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Lets a viewer watch the separate worker process act, without clicking. */}
        <div className="pb-2">
          <AutoRefresh intervalMs={5000} />
        </div>
      </nav>
    </header>
  );
}

export function Footnote() {
  return (
    <footer className="mt-10 border-t border-edge pt-5 text-xs text-ink-faint">
      <p>
        All partners are synthetic demo records on the reserved{" "}
        <code className="font-mono">@example.com</code> domain. Outbound email is captured
        locally by Mailpit and never reaches the public internet. No social platform is
        contacted, and no message is sent without creator approval.
      </p>
    </footer>
  );
}
