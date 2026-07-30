# Roadmap

What CollabOS would need next, in the order the current architecture suggests. Nothing here is
built — this document describes intent, not capability.

---

## 0. Immediately blocking

**Connect a Mind.** Everything Mind-dependent is implemented against the verified client-library
contract but has never made an authenticated round trip. Supplying
`MINDS_BUILDER_API_KEY` and `MINDS_MIND_ID`, then running `npm run minds:smoke`, closes the
largest gap in the project — see `docs/known-limitations.md` §1.

Concretely unverified until then: the Mind's actual ranking judgement, a real Circle mutation,
live cognition balance, and follow-up wording from a real model.

---

## 1. Next, if this became a product

### Authentication and multi-tenancy
Today there is one seeded creator and every browser session is "Maya". The approval gates are
enforced server-side but there is no notion of *who* approved. Real auth is the prerequisite for
the gates meaning anything, and for more than one creator existing.

### Real audience measurement
The single most valuable missing capability, and the one the current design deliberately refuses
to fake. Reading YouTube/Instagram/TikTok analytics through official APIs (with creator OAuth
consent, never scraping) would let `performanceScore` become measured rather than
creator-reported — which in turn makes "learns which partnerships actually grow the audience"
literally true rather than aspirational.

Until then the honest position stands: reliability is derived from observed delivery behaviour,
and audience growth is not measured at all.

### A real message provider
The `EmailTransport` interface exists precisely so this is a drop-in. Adding a provider
implementation requires no change to campaign logic. It does require: verified sending domains,
unsubscribe handling, bounce and complaint processing, and a hard rule that a partner who opts
out is never contacted again — the `optedOut` flag and its checks are already in place.

### Partner discovery
CollabOS currently reasons over a *curated* candidate list. Real discovery means a searchable
partner corpus with audience overlap estimation, which is a substantial data problem of its own
and where a public creator marketplace (explicitly out of scope now) would eventually live.

---

## 2. Deferred by design

### Verifiable collaboration receipt
Roadmap-only, as `CLAUDE.md` §19 requires. The idea: on completion, publish a signed,
tamper-evident summary of what both parties agreed and delivered — useful for building portable
reputation across creators.

The current audit log already contains everything such a receipt would attest: approvals with
timestamps, exactly what was sent through which transport, delivery timeliness, and the resulting
memory update. It is deliberately **not** onchain, and no blockchain, token, or escrow work is
planned inside the hackathon scope.

### Multi-agent orchestration
Excluded from the MVP. If added later, the `MindsPort` seam is where a second Mind would attach —
but the current single-Mind, single-alias design is what makes continuity easy to reason about,
and splitting it should be driven by a real need rather than novelty.

---

## 3. Operational hardening

| Area | Gap today |
| --- | --- |
| Scheduling | Single-Postgres worker with lease claiming. Correct for concurrent workers against one database; no distributed scheduler. |
| Rate limiting | None on the public collaborator route. |
| Observability | Correlation IDs thread through every action, but there is no metrics export or tracing. |
| Secret management | `.env` only. `LINK_SIGNING_SECRET` has a development default. |
| Dependency advisories | `npm audit` reports upstream issues in `eslint`→`brace-expansion` and `next`→`postcss`/`sharp`; no non-breaking fix available. |
| Accessibility | Manual basics only — no axe/Lighthouse audit. |
| Backups / retention | None. The audit log grows without bound and has no retention policy. |

---

## 4. Product ideas worth testing before building

Listed as hypotheses rather than commitments, because each would need validation with real
creators:

- **Multi-partner campaigns.** The state machine assumes one approved partner. Supporting a
  cohort would mean per-partner sub-states.
- **Revision rounds with per-round deadlines.** A single revision loop exists; it reuses one
  deliverable rather than versioning submissions.
- **Negotiated terms.** Campaign terms are currently implicit in the brief. Changing them is
  listed as approval-required but there is no structured terms object.
- **Partner-side memory.** CollabOS remembers what the creator experienced. A partner has no
  view of their own reliability history, which may be the wrong asymmetry.
- **Suggesting *when* to collaborate**, not just with whom — the seeded data already records
  `lastContactedAt`, which is the seed of a cadence model.
