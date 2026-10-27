# Native ACP qualification checkpoint

This is an experimental implementation, not a release approval or a claim of
superiority to another adapter. Fake-agent tests and native-runtime results are
reported separately.

## Runtime and test scope

Native tests use Google's unmodified Linux x86-64 ACP runtime 1.4.3, verified
against registry SHA-256
`0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714`.
No Google account, subscription quota, OAuth grant, or real model inference was
used. The intended production path is Antigravity personal-account OAuth, not a
Gemini API key; login/refresh, entitlements, quota and consumer-backend inference
remain unverified. The text fixtures use a deterministic local Gemini-protocol backend through
the runtime's intentional operator-configured gateway startup path. This path is
supported by the packaged implementation; public documentation was not found.
It is not the personal-account path. No rollout gate or enterprise policy was
changed, and the fixture does not certify absence of incidental native egress.

## Verified native results

- Two fresh-profile raw ACP initialize/EOF cycles: protocol negotiation succeeded,
  exit 0, owned process groups gone, temporary profiles removed.
- Idle SIGTERM: terminated and cleaned up.
- Actual Rakazo process host plus official ACP SDK: two normal close cycles, idle
  cancellation and pre-cancelled launch passed. Repeated close was safe.
- Local synthetic text generation: session creation, model discovery, streamed
  text, `end_turn`, and clean exit passed.
- Fragmented response: 16-byte SSE fragments paced at 1 KiB/s with a 300 ms pause
  preserved the fixture response. This is not a whole-network 9.6 kbaud simulation.
- Cancellation during a delayed local generation: native `cancelled` observed in
  about 3.1 seconds, clean exit, process group gone.
- Complete prompt integrity: exact 64 KiB and 128 KiB synthetic ASCII and Unicode
  inputs all reached the local backend intact. These examples do not establish
  universal capacity, token limits, or real model quality.

### Inline MCP output and graceful finish

The adapter requests a 1 MiB native inline MCP output allowance. In bounded
native variants, 16/32 KiB ASCII and Unicode tool payloads were preserved; 128/512
KiB responses were still prefix-truncated at roughly 49 KiB. Rakazo therefore
limits the fully serialized JSON-RPC result envelope to 32 KiB, rejects larger
completed results without suggesting a retry, and fences later dispatches. These
measurements are runtime transport observations, not universal model-context
limits.

An independent fixture also preserved the exact 32,768-byte serialized JSON-RPC
response envelope, including its request ID and escaped/control/Unicode text.
The raw text was 19,635 bytes, SHA-256
`ca6093726c3038cabc84cc2e048062a52f11a66c1a867956aaf4f0427299b115`; all
markers survived, with one approval, dispatch and effect. This qualifies that
tested representation only.

The implementation's deterministic subprocess tests cover EOF exit status,
process-group disappearance, immediate and during-finish abort, timeout, nonzero
exit, descendant cleanup, callback draining and late-dispatch fencing. They use
synthetic child processes. A native `PiAgentRuntime` run initially exposed a
cancellation race: the hosted provider scheduled `run.close()` and then
immediately aborted its controller. The process host saw an already-aborted
signal, skipped `stdin.end()`, and sent `SIGTERM`. Lifecycle events showed no
stdin `finish`, then forced `SIGTERM` and child exit by that signal. The
successful root fixture kept the same ordering as the corrected path: it ended
stdin after `end_turn`, waited for child close and process-group disappearance,
and closed the session, MCP listener and gateway afterward.

The hosted provider now lets only a consumed normal `done` completion close
gracefully, after confirming no terminal error or pending tool work. It keeps the
external-abort listener active during close; an abort at that point still
escalates immediately. The optional Docker-init `--init` harness was rerun with
the checksum-verified native runtime, pinned Node 22, non-root UID, no network,
read-only root, dropped capabilities, no published ports and no `.env` mount.
With the MCP listener and local gateway left open through EOF, both source and
DB-only restored sessions reported stdin finish/close, child exit code 0, child
close, process-group disappearance and no forced signals. Both databases were
425,984 bytes with empty WAL/journal files. The fresh-profile restore retained
the complete synthetic tool-result marker in the model-facing request, returned
the expected final text, dispatched no second tool call, and kept the callback
and explicit synthetic approval counts at one. The observed restored marker was
inside a 101-byte serialized string; the native result itself was a short
synthetic marker, not a 16 KiB payload. This test does not qualify production
cursor persistence or enable completed-tool snapshots; those remain disabled.

## Failures and release blockers

### Large prompt integrity

A 524,431-byte synthetic Unicode prompt completed with `end_turn`, but the local
backend received only a matching 191,983-byte prefix and no ending sentinel.
The complete prompt was absent from both individual and combined text fields.
Explicit selection of the advertised fixture model did not change this result.
No explicit truncation/compaction event was observed. Synthetic model-list limits
and synthetic usage counters do not prove the native engine's actual capacity.

Only an eligible persistent main conversation can carry up to a 2 MiB serialized
caller envelope, and then only after exact saved-prefix, account, run and image
checks. The selected validated delta remains bounded by the 128 KiB native prompt
budget. Helpers and stateless calls reject an oversized full envelope before host
allocation. Nothing is truncated to fit. This is a resource ceiling, not a model
capacity or token guarantee, and arbitrary large initial/reconstructed context
remains unqualified.

An initial fixture incorrectly treated a final response as proof that the whole
input arrived. It was corrected: large-context success requires preservation of
the complete synthetic payload. The strict fixture remains failed for this input.
Do not describe this as a verified defect in Google's consumer backend; this was
the pinned native runtime's local-gateway path.

#### Expanded synthetic context matrix (2026-10-26)

`scripts/check-native-context-matrix.py` completed all 16 bounded sequential cases
against the same unmodified runtime: seven passed integrity checks and nine
failed them. All cases confirmed process cleanup. These are actual native
local-gateway observations, not mock-agent results or consumer-account tests.

| Synthetic input | Cases | Exact content outcome |
| --- | ---: | --- |
| 64 and 128 KiB, each ASCII, Unicode, mixed JSON/code | 6 | All preserved, including beginning/middle/end markers |
| 256 and 512 KiB, each ASCII, Unicode, mixed JSON/code | 6 | All lost the ending |
| 1 MiB, ASCII and mixed JSON/code | 2 | Both lost the ending |
| 512 KiB mixed JSON/code in four ACP text blocks | 1 | Only the first block fully preserved; ending absent |
| Four separate 64 KiB mixed turns, fresh-process DB-only restore before turn four | 1 | All four payloads preserved in the final request |

The eight oversized single-block cases retained an identical 191,985-byte
matching prefix for ASCII/mixed text, or 191,983 bytes for Unicode, despite very
different character counts. This supports a byte-oriented per-message truncation
observation, not a measured model-token limit or proof of the compiled algorithm.
The four-block case is not merely a separator discrepancy: the readable ACP
parser joins blocks with spaces, but both the normalized joined-payload check and
the checks for blocks two through four failed. Its 131,069-byte contiguous-prefix
metric stops at the first inserted separator; it is not a different cutoff.

The restored multi-turn case retained all 262,144 bytes of original user payload
across four separate messages. Its final gateway request contained 276,594 UTF-8
text bytes and 322,325 serialized JSON bytes. Thus this observation does not imply
a 128 KiB ceiling on total native conversation history. It also does **not**
qualify arbitrary Rakazo requests. Later changes allow an eligible persistent
main conversation a 2 MiB caller envelope only when the exact saved prefix and
account/run/image fences pass; its selected delta remains capped at 128 KiB.
Helpers, stateless requests and mismatched history still use the strict preflight.
The fixture demonstrated a narrow native restore path; real subscription capacity,
compaction, inference quality and arbitrary large initial/reconstructed context
remain unqualified.

Result artifacts: `acp-context-matrix/summary.json` and the 16 per-case JSON files
in the retained native qualification evidence. They contain structural integrity
results, not raw synthetic prompts or native state. The legacy gateway helper's
`start_sentinel_present`/`end_sentinel_present` fields refer to its old marker;
this matrix's `sentinels` and full-payload checks are authoritative.

Two opt-in longitudinal cases (`--longitudinal`) then tested the earlier 2 MiB
snapshot bound before the later 4 MiB contract. Both ended as controlled failures with
confirmed cleanup:

- **Eight 64 KiB turns:** all 524,288 payload bytes remained intact, including
  fresh-process restore before the eighth turn. The seven-turn selected DB was
  1,966,080 bytes, but the final clean DB was 2,195,456 bytes, above the 2,097,152-byte
  snapshot limit. Native content preservation passed; durable export eligibility
  failed. This is not a successful 512 KiB durable-provider qualification.
- **Sixteen planned 64 KiB turns:** fifteen completed, then the selected clean DB
  was 3,637,248 bytes, so the fixture rejected restoration before turn sixteen.
  Exact historical payload preservation also failed earlier: generation twelve
  contained all twelve user payloads; an additional generation during that same
  turn contained only 25,003 text bytes and no complete original payload. Later
  generations retained the new thirteenth through fifteenth payloads, but not
  the complete first twelve. This pattern is consistent with native compaction,
  not a demonstrated transport-size failure. The largest serialized gateway
  request was 940,249 bytes, below the unchanged 2 MiB request bound.

The deterministic backend returns a canned response even to an apparent summary
request: these observations cannot evaluate compaction's semantic quality or
establish a real model's context threshold. They do establish that exact retention
of arbitrarily accumulated history and durable snapshots beyond the current
bound are not qualified. An oversized snapshot must not become a reusable cursor;
an ensuing oversized full-history request must reject rather than silently replay
or truncate. Evidence is retained under `acp-context-longitudinal/`.

The implementation subsequently adopted a bounded 4 MiB raw-state contract,
with coordinated 8 MiB private relay frames and encrypted-storage limits. The
matched `64k-mixed-9-turns-restore-4mib-contract` native fixture passed: all nine
64 KiB payloads were preserved, a 2,195,456-byte database restored successfully
before turn nine, and the final clean database was 2,424,832 bytes. Cleanup was
confirmed. This qualifies that synthetic native restoration case, not arbitrary
model capacity, useful compaction, or the deployed container image.

Only an eligible persistent main conversation can use a bounded 2 MiB caller
envelope. Exact saved-prefix, account, run and image validation must succeed;
the selected delta still must fit the unchanged 128 KiB native prompt budget.
Without valid saved state, an oversized full history rejects before helper
initialization. Helpers and stateless runs retain the strict pre-allocation
budget. No implicit splitting, truncation or replay is used.

### Native tool permission handoff

Native MCP tools are lazy by default. The implementation now requests eager
schemas for its exact scoped bridge rather than relying on native filesystem
schema discovery. This is schema projection, not approval.

The eager-schema fixture discovers the intended tool, but when the canonical
image-gated bridge is absent or unverified, native permission denial prevents it
from reaching Pi's callback. Schema discovery alone does not establish automatic
tool execution.

A separate controlled explicit-approval fixture now passes the complete real
runtime path: native ACP, scoped authenticated MCP bridge, exactly one Pi callback,
the callback's result returned in a native function response, and final `end_turn`.
It uses a deterministic local backend emitting only the known in-memory fixture
call and simulates one explicit approval. It is not an automatic authorization
policy and must never be installed as one. Output labels this distinction.
The native response wraps the MCP text in an `output` string; the fixture checks
the literal result there rather than assuming it is an unwrapped scalar.

The internal SDK has canonical tool/server identities, but the examined ACP
permission serialization does not preserve those independently. Its MCP metadata
can also be derived from argument shape. No per-server approval/trust switch was
found in the examined contract. Do not authorize a native command merely because
its title or metadata looks like a bridge call. Global permissive mode is not an
acceptable substitute.

The optional image now implements a separate canonical pre-tool gate: exactly one
owned MCP registry, opaque projected names, a fixed image script, exact global
hooks configuration and build-authored interpreter/script provenance. Preparation
checks artifacts and closed session configuration before fresh/load startup and
before each outer handoff approval. Missing preparation fails closed; hosts
without image provenance retain default native denial. Pi's existing callback
still owns actual effects. No public provider qualification switch was enabled.

Fifteen bounded native functional cases passed. Nine cover baseline, explicit
hook denial, exact-name allowance, harmless nonallowlisted MCP denial, both
resource helpers blocked, nonzero/malformed hook failures and Pi denial after
handoff. Three run allowance/nonallowlisted/Pi-denial cases with the byte-identical
production gate program from temporary fixture artifacts. The final three repeat
those outcomes after a text-only first turn, clean close, DB-only restore into a
fresh private profile, fresh MCP endpoint and reinstall of the same gate.
The restored session again enforced allowance, nonallowlisted denial and Pi
denial after handoff. No pending-tool restoration was exercised.
Denied cases reached no MCP effects; allowed handoff followed by Pi denial had one callback and zero
effects. Every case cleaned up. The fixtures pre-authorize an explicit synthetic
outer decision; they do not themselves qualify production automatic approval.
The temporary artifacts do not qualify fixed-path image installation.

The gate assumes a trusted pinned runtime in a private account host: no bot
workspace binds, untrusted co-resident programs, or Pi effects on that host's
filesystem. File modes alone are not containment against arbitrary same-UID
modification. Inputs over 1 MiB are denied, including valid oversized arguments.
Actual image installation and consumer-account operation remain untested.

### Outage behavior

A local 503 fixture caused three generation attempts, then exceeded the fixture's
22-second RPC budget without a response. Cleanup succeeded. This characterizes
retry behavior, not successful failover and not a real Google outage. Never infer
retry permission from arbitrary assistant error prose.

### Private hosting and account integration

Hosted login, exact-connection model discovery and native inference are wired to
separate actor-owned account-operation hosts. Pi tools remain on their existing
bot computer. Unsupported hosts and unqualified images fail before allocation;
there is no API-host, desktop or shared-bot-computer fallback. Offline tests cover
lease/quota ownership, isolated process dispatch, cancellation, uncertain
allocation, durable launch/close fences and cleanup. These are implementation
checks, not evidence that the real optional Docker image has been qualified.

### Container build checkpoint

The ordinary computer base image was built in a separate environment. The optional
ACP image was not built: the pinned official `uv` artifact on `releases.astral.sh`
received an HTTP 403 in the original environment, and this coding task did not retry
that denied fetch. No alternate source or checksum bypass was used. The base-image
build does not qualify the unchanged `Dockerfile.acp`; no complete ACP image exists
from this checkpoint.

### Native conversation restoration

The vendor-runtime v2 fixture passed functional conversation restoration in a
fresh private profile; the stale MCP endpoint was not reused. This does not prove
restoration of pending native tool requests or exactly-once effects. The retained
conversation database still contains credential-bearing material: credential-free
storage qualification failed. Treat the entire snapshot as sensitive and require
private encrypted storage, separate from ordinary workspace files and artifacts.
Removing OAuth files from the copied profile is not sufficient sanitization.

The implementation now includes private conversation-state binding and fencing.
Actual image identity must be part of that binding; a static adapter version is
not a substitute for the allocated image's identity. The account-free fake-native
composition now covers a completed Pi tool loop, helper relay candidate transfer,
fresh-runtime delta-only restore, and executor binding to the assistant blocks
that are finalized into history. Separate PostgreSQL 18.6 coverage verifies that
candidate promotion occurs inside the successful history-finalization transaction.
The pinned native runtime has not yet been restored through the complete executor
composition, so this is not end-to-end production qualification.

### Database verification and remaining qualification

A fresh PostgreSQL 16.14 instance applied all 156 migrations and passed both
native-state integration tests and all 13 row-security tests. A subsequent fresh
PostgreSQL 18.6 instance applied all 156 migrations and passed four native-state
tests, including exact 4 MiB encrypted save/reload and promotion inside the
successful history-finalization transaction, plus all 13 row-security tests. The
disposable databases were local and synthetic. The PostgreSQL 18.6 container from
the latest run was stopped and removed after validation.
These results verify the tested database paths, not a deployment or vendor
account flow.

Public provider selection, actual image/runtime deployment qualification,
personal-account authentication, safe production native-tool authorization,
real quota/outage signals and backend qualification remain incomplete. Keep the
provider unavailable by default. The optional image is not marked qualified by
this repository, and no live Google sign-in is implied by the offline results.

## Reproduction

Run from the repository root with dependencies installed from the lockfile.
Ordinary unit runs should not fetch packages. The local tarball packaging fixture
explicitly sets npm offline mode, disables lifecycle scripts and disables update
notifications. These checks do not need the vendor runtime:

```sh
pnpm test:acp
python3 scripts/check-native-acp.py --self-test
python3 scripts/check-native-acp-conversations.py --self-test
```

The remaining commands are opt-in native fixtures, not routine unit tests. They
require separate authorization, a compatible host and the verified vendor binary
already installed; use an absolute executable path in place of `/absolute/runtime`.
They use temporary synthetic profiles, not an existing account profile. The gate
fixtures simulate a scoped outer decision and do not enable production approval.

```sh
python3 scripts/check-native-acp.py --run /absolute/runtime --uid=
node --import tsx scripts/check-native-acp.ts /absolute/runtime
# Functional DB-only restore and credential-bearing-state classification:
python3 scripts/check-native-acp-conversations.py --db-only --run /absolute/runtime --uid=
python3 scripts/check-native-acp-gateway.py --case large --large-bytes 131072 --large-alphabet unicode --run /absolute/runtime --uid=
RAKAZO_FIXTURE_EAGER_MCP=1 node --import tsx scripts/check-native-acp-tools.ts /absolute/runtime --uid=
# Controlled explicit-approval branch, not production authorization:
RAKAZO_FIXTURE_EAGER_MCP=1 RAKAZO_FIXTURE_EXPLICIT_APPROVAL=1 node --import tsx scripts/check-native-acp-tools.ts /absolute/runtime --uid=
# Byte-identical production gate program, temporary fixture paths only:
node --import tsx scripts/check-native-acp-hooks.ts fixed-allow /absolute/runtime --uid=
node --import tsx scripts/check-native-acp-hooks.ts fixed-other /absolute/runtime --uid=
node --import tsx scripts/check-native-acp-hooks.ts fixed-pi-deny /absolute/runtime --uid=
# Fresh profile/session-load gate lifecycle; no pending tool restoration:
node --import tsx scripts/check-native-acp-hooks.ts fixed-load-allow /absolute/runtime --uid=
node --import tsx scripts/check-native-acp-hooks.ts fixed-load-other /absolute/runtime --uid=
node --import tsx scripts/check-native-acp-hooks.ts fixed-load-pi-deny /absolute/runtime --uid=
```

The ungated native tool fixture intentionally retains native permission denial;
do not count that default-denial run as a successful tool round trip. The separate
gated fixtures above test the bounded local handoff behavior. Native gateway cases
also include `basic`, `fragmented`, `cancel`, and `outage`. Only explicitly
configured local synthetic traffic is initiated by the fixture; real vendor
startup may have independent behavior.

Read the emitted structured result as well as the command's exit code. In
particular, the conversation fixture can report `functional_status: passed` while
`credential_free_storage_qualification` and overall `status` are `failed`; an
overall failure exits nonzero. For the pinned runtime this is the expected outcome:
functional continuity passed, but credential-bearing state still requires private
encrypted storage. Do not discard that distinction or turn the storage failure
into a green qualification. The default tool-denial fixture and known
oversized/outage cases are likewise not successful qualification simply because
cleanup completed.

The opt-in database checks are separate from `test:acp`:
`packages/db/src/native-conversation-state.postgres.test.ts` and
`packages/db/src/row-security.postgres.test.ts`. Their guards require an explicitly
configured test database (`VERIFY_DATABASE=1`, `DATABASE_URL`, and a distinct
`DATABASE_MIGRATION_URL` for row-security checks). Use a disposable migrated
database and its non-superuser runtime role; never point them at a live database.
The tests do not provision PostgreSQL or apply migrations for you.

Focused offline and database checks are not a native qualification result. Report
full-suite counts against the exact tested revision, with skipped and unrun stages
separate; historical adapter-suite totals do not establish the current build's
status.
