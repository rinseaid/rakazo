# Antigravity ACP integration (experimental)

This implementation is not enabled by default. It is an adapter prototype, not
an assurance that Google authorizes every deployment or that mocks establish live
compatibility. Native login, discovery and inference require a qualified private
account-operation host. There is no fallback to the API machine, a selected
desktop, or a bot's computer.

This path uses Google Antigravity personal-account OAuth through the native ACP
runtime; it is not Gemini API-key authentication. Real login/refresh, subscription
entitlements, quota behavior and consumer-backend inference remain unverified.
The provider and its placeholder are hidden by default. A single-API test instance
must explicitly set `RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED=true` on the API process;
the backend enforces the same gate for sign-in, discovery, selection and runs.
Sign-in sessions and discovered-model generations are process-local, so the test
instance needs API affinity. Restarting the API requires restarting sign-in or
rediscovering the account models. This local test gate does not qualify a deployment.

For measured results and unresolved blockers, see the
[qualification checkpoint](antigravity-acp-qualification.md). This document covers
the implementation boundaries and maintainer workflow; neither document enables
the public provider.

## Integration boundaries

- Rakazo retains account/Space selection, encrypted connection storage, the Pi
  agent loop, tool execution, checkpoints and the existing fallback coordinator.
- Native credentials are an explicit `native` secret variant. They are not fake
  API keys or synthetic access tokens. Refresh snapshots are fenced against the
  original connection and ciphertext; reconnect/disconnect wins over stale saves.
- The Google binary performs OAuth. The manual loopback callback relay verifies
  Google origin, PKCE parameters, destination and state. Credentials do not pass
  through logging, chat or model prompts.
- Each login, catalog probe and native model instance gets a separate ephemeral
  account host. Bot tools stay in Pi on their existing computer; native credentials
  never enter that computer or inherit the API process's environment.
- The official ACP SDK handles wire framing/dispatch. Native filesystem and
  terminal client callbacks are denied. This is not an OS sandbox: the process
  still must run in its private account host.
- The scoped MCP bridge yields actual Pi tool calls and waits for Rakazo's result.
  It does not execute tools independently or turn denied calls into success.
- Google-specific built-in tool-filter metadata is defense in depth, not a
  security boundary or a promise of supported tools-free inference.

The shared login lifecycle and API finish endpoint accept native credentials.
API and worker register the same actor-bound provider factory. Login, catalog and
inference use the provider-neutral optional account-operation capability and the
existing authenticated supervisor/duplex transport. Model creation is lazy; every
helper or fallback instance gets its own immutable lease. Missing actor or
connection identity, unsupported providers and unqualified images fail closed.

Account-operation hosts are separate resources, not synthetic bots or Team
computers. They have no bot home bind mounts, workspace exports, screen routes or
arbitrary command interface. The supervisor uses a pinned image, private network,
read-only root and bounded temporary storage. Ordinary computer routes reject
these resources. Database quota reservations precede allocation; expiry alone does
not release quota. Confirmed destruction, durable launch/close fences and expiry
sweeps cover cancellation, uncertain creation and supervisor restarts. Closed
fence metadata remains until expiry to prevent a late request reviving a lease.

`discoverAcpModels` obtains account-scoped choices from a no-prompt ACP session,
preferring standard model config options over legacy metadata. The shared catalog
probe resolves an exact caller-owned connection and preserves its existing
ciphertext/reconnect fence when saving refreshed native state. Discovery supplies
only declared identity/display metadata, not inferred context limits or multimodal
capabilities. The server cache binds the current profile revision to one credential;
cache loss or staleness requires rediscovery before selecting or running that model.
The implementation gate is not release approval.

### Code map

Start at the composition roots, not the native fixture scripts. Paths below are
under `packages/adapters/src/` unless stated otherwise.

| Responsibility | Entry points |
| --- | --- |
| Existing Pi loop and provider extension | `pi-runtime.ts`, `pi-acp-provider.ts` |
| API/worker composition, exact-connection checks and server-owned history cursors | `google-acp-remote.ts`; registered by `apps/api/src/app.ts` and `apps/worker/src/index.ts` |
| Provider-neutral account-host leases and private process transport | `account-operation-host.ts`, `docker-account-operations.ts`, `duplex-process.ts`; supervisor `account-hosts.ts` and `process-channel.ts` |
| Private helper, native run and per-run profile | `cli/acp-host.ts`, `google-acp-host.ts`, `google-acp-provider.ts`, `acp-local-profile.ts` |
| ACP protocol and Pi tool handoff | `acp-session.ts`, `acp-transport.ts`, `acp-run-relay.ts`, `acp-tool-server.ts`, `acp-mcp-listener.ts` |
| Native login, catalog and credential refresh | `hosted-native-account.ts`, `native-account-relay.ts`, `google-acp-login.ts`, `google-acp-catalog.ts`, `google-acp-profile.ts`, `model-native-credential.ts` |
| Conversation binding, encryption and fencing | `google-acp-remote.ts`, `acp-conversation.ts`; `packages/db/src/native-conversation-state.ts` |
| Fixed optional-image gate and artifact build | `google-acp-tool-gate.ts`; `scripts/build-acp-host.mjs`, `infra/sandboxes/computer/Dockerfile.acp` |

The API/worker side may depend on the database; the private helper must not.
Keep native-side imports pointed at `google-acp-host.ts` and other narrow modules,
not the server-side `google-acp-remote.ts` or the adapters barrel. The
`acp-host-bundle.test.ts` build-graph regression rejects database and account-host
allocation dependencies in that bundle. Shared host/auth contracts belong in
`adapter-kit`; Google translation stays in these adapters. No additional agent
loop, fallback coordinator or provider-configuration framework is needed.

### Durable private conversation state

Main-agent text turns can restore a completed native conversation through the
private account host. Helpers stay ephemeral. The adapter preserves only the
opaque session `.db`, never the sidecar (which may contain persistent permission
decisions), a whole profile, or a bot workspace. It neither parses nor rewrites
SQLite. The native database can retain previous MCP bearer credentials and
endpoints: it is sensitive private state, not an ordinary downloadable artifact.

`NativeConversationState` stores one latest snapshot per logical main conversation,
separately from account credentials and per-run checkpoints. Encryption is mandatory
even with `CONTENT_ENCRYPTION=off`; missing keys fail closed. The raw database is
limited to 4 MiB without truncation, within the private 8 MiB relay frame bound.
Account-profile initialization retains its separate, smaller bound.

Bindings cover actor/Space/thread/bot, connection and the generation of the exact
credential loaded, model, adapter/runtime package, actual private-host image,
history-compaction generation, and system/tool/context policy. The authenticated
supervisor attests the image ID from the owner-verified immutable container; a
caller-supplied tag or qualification label is not used as its identity. The private
process carries that identity nonenumerably. Older hosts lacking the identity can
run fresh conversations but cannot restore or save this cache.

Claiming state checks the current run, private-host and account fences, then
atomically consumes the old snapshot before native mutation. A retained previous
host row prevents another claim until destruction is confirmed. Saving requires
the same ownership, binding and revision. A snapshot requires a successful
`end_turn`, sealed and settled MCP callbacks, an explicit stdin-EOF finish with
exit code zero, disappearance of the owned process group, and empty WAL/journal
files. Cancellation and errors retain the immediate TERM-to-KILL close path and
never qualify for persistence. A timeout, nonzero exit, late dispatch or lingering
descendant refuses persistence even if forced cleanup later succeeds. The provider
offers only a bounded in-memory candidate after clean EOF and settled callbacks.
Pi must complete its tool/final loop; then the executor binds the candidate to the
exact assistant history it commits in the run transaction. Failed, silent,
ambiguous or ineligible runs discard it. Synthetic Pi/factory/relay tests cover
tool-result completion and delta-only restore; the pinned native runtime has not
yet been restored through this full executor path.

The delivered-context cursor hashes the canonical message prefix, including the
final assistant text. Canonicalization preserves Pi's server-tagged history roles
and ignores text-chunk boundaries; it never guesses an assistant role from a user's
literal `Assistant:` prefix. A matching prefix sends only new transcript data to
the restored session. Edited/truncated history or changed policy, model, image or
compaction boundary starts fresh rather than reusing incompatible state. This is
best-effort compatible continuity, not a promise that every turn resumes.

ACP loading remains capability-gated, revalidates model/mode, suppresses historical
output replay, and resends fresh system/tool configuration and MCP bindings. It
does **not** resume pending MCP requests or authorize replay of external effects.
The pinned native v2 offline fixture verified two-process text continuity, fresh
MCP authentication, no reuse of the stale endpoint, and clean exits. Its overall
credential-free-storage qualification intentionally failed because the selected
425,984-byte database retained the old bearer and endpoint. This supports mandatory
private encrypted storage, not credential-free storage, Google-account authentication,
or deployment qualification. Deterministic composition tests also exercise two
actual `PiAgentRuntime` turns with persisted history and multi-chunk output; these
are fake-native tests, distinct from both that native fixture and live PostgreSQL
integration checks. The disposable PostgreSQL 16.14 verification applied all 156
migrations unchanged and passed the two native-state integration tests plus 13
row-security tests using a non-superuser runtime with security guards. PostgreSQL
PostgreSQL 18.6 verification is recorded in the qualification checkpoint below.
A production migration and deployed-image qualification remain unverified.

## Failure semantics

A classified, retry-safe provider failure before output may use the existing
fallback chain. Once output or a tool call has been surfaced, a retryable native
failure becomes an unknown outcome. The adapter does not silently restart that
prompt or invent a successful tool result.

Google ACP requests a 1 MiB native inline MCP output allowance to avoid its small
default spill-to-file behavior. Rakazo separately caps the fully serialized
JSON-RPC tool-result envelope at 32 KiB (including the response ID and UTF-8
content). Larger completed results are withheld with an explicit no-repeat error;
the native run is cancelled and further dispatch is fenced. These are transport
and operational bounds, not model-context guarantees. Native fixtures preserved
16/32 KiB ASCII and Unicode results at the 1 MiB setting, while 128/512 KiB
results were still prefix-truncated. Pi also clips ordinary tool text before it
reaches ACP; `list_fleet` and `skill_read` are deliberate verbatim exceptions.

Concurrent duplicate MCP request IDs are rejected before SDK dispatch. This is
not durable exactly-once delivery. A completed action whose response is lost
cannot be distinguished from an intentional new action using plain JSON-RPC IDs.
Domain operation keys, transactional effects and Rakazo's effect/checkpoint
semantics remain necessary. The adapter does not cache completed tool results by
payload and pretend repeated reads or writes are the same operation.

Some current Google ACP server failures are rendered as ordinary assistant text,
not authoritative error codes. Arbitrary response text is not treated as permission
to retry or evidence of a rate limit. Live quota/outage behavior remains a required
qualification item; simulated 429/503 tests are not evidence of real Google signals.

The initial Google adapter advertises text input only. Images, native usage
accounting, safe replay across all server versions and provider-specific effort
controls are not qualified yet. Zero usage fields mean unavailable telemetry,
not free inference. Oversized input is rejected, not silently truncated.

The Google run retains a fixed conservative experimental **128 KiB UTF-8 wire
prompt budget**, including current system text and projected tool schemas. Helpers
and stateless calls check the full prompt before allocating a host. A persistent
main conversation may carry up to **2 MiB of serialized caller context and tools**
for local prefix validation; that is a resource ceiling, not advertised model
capacity. The private host must first be allocated to attest its actual image.
Only an exact, fenced saved-history prefix permits sending just the new delta,
which still must fit 128 KiB. Missing state, changed policy/model/image/history,
or lost state after cancellation cannot fall back to replaying oversized history:
the request fails before helper initialization or vendor inference and the idle
host is destroyed. No history is silently removed to make it fit.

The opaque native snapshot independently remains capped at 4 MiB. An oversized
snapshot is a failed durable close, not successful persistence; a later request
must start fresh within the prompt bound. Consequently this is bounded incremental
continuity, not unlimited conversation capacity. Native local-gateway testing
found large single prompts could lose their ending without an error, while
multiple smaller restored turns retained their cumulative history; see
[qualification checkpoint](antigravity-acp-qualification.md).
Snapshot transport remains opaque version-1 base64 (no compression). Its 4 MiB
raw ceiling fits the 8 MiB encrypted-column bound and 8 MiB private relay frame;
queued relay bytes are capped at 16 MiB. This increases fixed read buffers and
transient base64/encryption copies, so memory use is several times the raw snapshot,
not a streaming 4 MiB allocation. API and private helper image must be qualified
and updated together; older readers reject larger state, and a changed actual
image identity deliberately invalidates earlier caches. The caller-envelope and
wire-prompt limits above do not increase with snapshot capacity.

Native calls reach Pi only through the canonical gate authored into the qualified
private account-host image. Missing or unverified gate provenance denies calls;
schema projection alone never authorizes a tool. Public provider selection remains
disabled.

## Offline qualification

```sh
pnpm test:acp
pnpm --filter @rakazo/adapters check
pnpm --filter @rakazo/api check
pnpm exec vitest run --maxWorkers=2 apps/api/src/router.test.ts
```

`test:acp` uses synthetic credentials, fake agent subprocesses, the real ACP/MCP
SDKs, and loopback-only test listeners. No Google account or live inference is
required. It includes:

- full native-login relay against a fake process;
- Rakazo runtime -> ACP subprocess -> authenticated MCP -> normal tool callback;
- profile isolation, permission modes, cancellation and late results;
- 429/503 classification, partial-progress failures and no automatic effect replay;
- duplicate/disconnected requests and deliberately ambiguous completed replays;
- fixed-seed malformed data, huge histories/schemas/results and exact UTF-8 bounds;
- fragmented/slow streams, truncation, malformed JSON, write failures and crashes;
- stale/reconnected/disconnected credential saves and uncertain database outcomes.

For the broad adapter suite, keep inherited telemetry sampling deterministic in
the test process (for example `OTEL_TRACES_SAMPLER=always_on`). Run type-checks and
large suites separately on memory-constrained workers. Report failed, skipped and
never-run stages separately.

These tests do not prove immunity to arbitrary RAM corruption, malicious native
binaries, hardware failure, or real provider outages. Valid-but-corrupted data may
be indistinguishable without an authenticated higher-level contract. Fault tests
exercise defined observable failure cases rather than claiming hardware repair.

### Opt-in native lifecycle checks without an account

On an authorized compatible host with the verified vendor binary already installed:

```sh
python3 scripts/check-native-acp.py --self-test
python3 scripts/check-native-acp.py --run /absolute/path/agy_acp_server.par --uid=
pnpm exec tsx scripts/check-native-acp.ts /absolute/path/agy_acp_server.par
```

These do not call authenticate, session/new, session/prompt, session/load or tools.
The standalone Python check tests two fresh-profile initialize/EOF runs and idle
SIGTERM with owned-process-group cleanup. The TypeScript check exercises the real
Rakazo process host and ACP SDK: two normal close cycles, idle cancellation and
pre-cancelled launch. Native 1.4.3 passed these seven lifecycle cases on the cloud
desktop. This does not establish authenticated profile isolation, prompt behavior,
network inactivity or recovery of a native conversation. In particular,
session/new can initiate interactive sign-in, so it is not a no-account probe.

## Before live enablement

1. Update the database additively, then deploy compatible API and worker builds
   with provider selection closed. Update the supervisor account-host contract
   and pinned helper image as one release; verify both sides' protocol and gate
   digests before enabling selection. Keep the gate closed while API/worker or
   supervisor/helper versions are mixed. Older API releases do not count new
   account-operation quota records. On rollback, close selection first, restore
   the prior compatible API/worker and supervisor/helper pair, and retain additive
   schema until old readers are gone.
2. Qualify the actual private account-host image. Image labels are operator
   assertions, not a substitute for the native and container fixtures.
3. Verify the official runtime archive against the ACP registry digest and pin
   the tested version. Do not silently install a newer unqualified binary.
4. Review Google's current terms and obtain explicit user participation in OAuth.
5. Perform a bounded live login/model/tool/cancel/restart check before any scale
   or quota testing. Never run bulk stress prompts against a user's account by
   default.
5. Complete a final adversarial pass against the exact release candidate and
   run the repository's ordinary review workflow after publication is authorized.

## Comparison baseline

Paseo's native Antigravity provider at commit
`d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed` uses CLI stream-JSON, not ACP.
It has native conversation restoration, a model catalog obtained from the CLI,
and completed-step usage reporting. Those are meaningful capabilities; this
prototype does not claim parity merely because its offline tests pass.

Paseo also has a separate generic ACP framework with session loading, negotiated
configuration, MCP servers and permission UI. The archived standalone Antigravity
ACP plugin is another implementation, not the current native CLI provider.
Comparisons should name the exact implementation and revision rather than treating
all three as one adapter.

The intended distinction here is real Pi-owned tool execution and Rakazo's existing
connection and fallback lifecycle. Deployment-qualified native restoration, public discovery, accurate
usage representation and a qualified production host remain acceptance work.
Automatic fallback must not be added by guessing from natural-language errors.

Sources: [Paseo native provider](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/plugins/antigravity-provider/server/provider.ts),
[native catalog](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/plugins/antigravity-provider/server/internal/catalog.ts),
[generic ACP framework](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/plugin/src/server/acp-internal/connection.ts).

## Maintaining and updating

Use the repository's pinned Node/pnpm versions and install from `pnpm-lock.yaml`
before verification. Do not make a test or model prompt fetch a missing dependency.
The default ACP suite runs without a vendor archive, Docker or Google account.

For an ACP/MCP/Pi dependency update:

1. Update the exact dependency in `packages/adapters/package.json` and the lockfile
   together. Keep the official SDK responsible for protocol framing and schemas;
   do not fork its behavior into a second transport implementation.
2. Run `pnpm test:acp`, the adapters/API/worker/database/supervisor type-checks, and
   the ordinary repository checks required for the changed packages. The focused
   suite includes helper bundle isolation and Pi history attachment regressions;
   it is not the entire backend suite or an opt-in PostgreSQL integration run.
3. Run `node scripts/build-acp-host.mjs` and inspect the generated helper artifacts.
   They remain ignored build outputs, not source files to edit or commit.
4. Repeat only the authorized native qualification relevant to the change on a
   compatible host. Keep synthetic, actual-image and consumer-account results
   separate, and update the checkpoint without promoting unrun stages to passes.

For a native runtime update, review the deliberately pinned boundaries together:

- `Dockerfile.acp`: archive filename/digest, executable layout, pinned Node image,
  and the build-authored gate manifest's `runtimeVersion`;
- `google-acp-tool-gate.ts`: the accepted manifest runtime and fixed artifact paths;
- `google-acp-remote.ts`: the runtime package identity used for conversation reuse;
- qualification fixtures and this checkpoint: supported platform, observed
  capabilities, input limits and outstanding failures.

A new version is unqualified until checked; changing a version string or image
label does not qualify it. If transcript projection or policy compatibility
changes, review the context-binding version in `google-acp-remote.ts` as well.
Keep additive migrations compatible with the previous release, retain the public
availability gate, and do not treat a dependency update as authorization to deploy
or sign in to an account.

## Optional computer image preparation

The ordinary computer image does not acquire a Node or Google runtime dependency.
An optional `infra/sandboxes/computer/Dockerfile.acp` layers a pinned Node runtime,
the bundled helper, and an explicitly supplied Google ACP 1.4.3 Linux x86-64 archive.
It verifies the archive's registry digest. ARM and other runtime versions remain
unqualified. Generated bundles and vendor archives are ignored, not checked in.

The vendor archive must be supplied separately in
`infra/sandboxes/computer/vendor/` from the official registry distribution, after
reviewing its terms. With the ordinary `rakazo/computer:local` image already built,
prepare the ignored helper artifacts and optional image from the repository root:

```sh
node scripts/build-acp-host.mjs
docker build --platform linux/amd64 -f infra/sandboxes/computer/Dockerfile.acp \
  -t rakazo/computer:acp-local infra/sandboxes/computer
```

This builds an optional runtime-image candidate; it is not a deployment or
qualification step. Neither normal image builds nor model prompts download/install
a vendor executable.

The optional image is not marked qualified by this repository. The supervisor
requires `rakazo.account-host.protocol=1`, `rakazo.account-host.qualified=true`,
and no image-declared volumes before allocation; it also verifies the deployment's
restricted-egress setup. These checks do not replace actual image/runtime testing.
No provider-specific environment switch enables the account host.

The helper's stdout is exclusively the private protocol, not a log sink. Secrets
are sent only through the scoped process channel, never argv or workspace exports.
EOF/signals trigger native cleanup; unconfirmed cleanup exits 125. Process-group
termination is lifecycle management within the existing computer isolation, not
containment of arbitrary malicious descendants.

Current qualification limits: the verified Linux 1.4.3 runtime failed before login
on the coding executor, including `--help`, with a tcmalloc CPU-detection assertion
and exit 134. Its Linux CPU sysfs interface is absent. On a separate ordinary cloud
desktop, the same verified archive starts and completes a real `initialize`
handshake (protocol 1; personal OAuth, session loading and HTTP MCP advertised).
That desktop's native outbound connections to Google's OAuth endpoint fail, so no
personal-account login or live Google inference has been attempted. Browser
connectivity does not prove native runtime connectivity. Actual container and
Google qualification remain pending.

References: [official ACP registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp),
[ACP SDK](https://github.com/agentclientprotocol/typescript-sdk),
[Google ACP integration](https://antigravity.google/docs/ide/extensions/zed/),
[Google terms](https://antigravity.google/terms).
