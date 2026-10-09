# Read-only guarded-owner readiness

Source prepared from accepted Linki guard commit `73f9bf2156ea7f237a01263d49d9740467488cdb`.
This is not a deployed capability or proof of a usable live owner session. The
primary checkout, credentials and account store are not modified by this work.

`POST /api/echo/readiness` requires the existing `x-internal-secret` and exactly
`account_id`, `workflow_id`, `list_id`, `guard_revision`,
`approval_manifest_digest`, `challenge`. IDs are nonempty strings up to 256
characters. The revision is `sha256:` followed by 64 lowercase hexadecimal
characters; digest and challenge are 64 lowercase hexadecimal characters.
Echo generates a fresh challenge per poll. Linki returns the six fields plus
`guarded_owner_ready: true` and an aware UTC `checked_at` only after all checks.
Blocked observations return HTTP 409 and a finite reason. Responses are no-store.

The owner-reviewed `ECHO_READINESS_CONFIG` is a canonical absolute private JSON
file, containing exactly these keys:

```json
{
  "account_id": "existing-account-id",
  "workflow_id": "existing-workflow-id",
  "list_id": "existing-list-id",
  "account_profile_url": "https://www.linkedin.com/in/existing-owner",
  "bridge_action_url": "http://127.0.0.1:3457/echo/action",
  "guard_revision": "sha256:<reviewed-built-source-digest>",
  "approval_manifest_path": "/absolute/private/existing-approval-manifest.json",
  "approval_manifest_digest": "<reviewed-full-canonical-manifest-digest>"
}
```

The illustration contains placeholders and is not an attestation. No config
file is created by the producer. Config and manifest must be owned regular
files, with no group/other permissions, symlink or hardlink. The manifest digest
covers the complete parsed JSON, including array order, nulls and explicit
defaults, using Python `json.dumps(sort_keys=True, separators=(',', ':'))`
ASCII escaping. Floating-point/exponent numbers are rejected rather than
guessing Python's serialization; current approval fields use safe integers.

The producer reads the existing database using a separate `readonly` /
`fileMustExist` connection. It never calls `getDb()` because that accessor runs
migrations. The actual workflow must have one existing pending, paused or running
run associated with exactly the reviewed account/list, and only `connect` or
`visit → connect` steps on the LinkedIn track. The executor does not filter
disabled steps, so readiness inspects those too. Its Echo workflow-name predicate
must apply to the whole workflow. Every list target must have valid actual Echo
scope and every existing run profile must belong to that list. No run,
enrollment, claim or reservation is created during this inspection.

The existing executor starts from `instrumentation.register` even when every
workflow is paused. It registers the build revision exported by its actually
loaded guard module and clears registration if its loop exits with failure.
There is no new timer or scheduler and no arbitrary heartbeat expiry that would
misclassify a long action tick. Next computes the reproducible source digest at
production build time over framed filenames and exact bytes of the executor,
guard, connect, visit, session and readiness implementations. The same embedded
constant reaches the loaded guard, executor and producer. Runtime environment,
repository HEAD, reviewed config and request fields cannot supply missing
registration. Development builds deliberately lack a readiness stamp. The Git
base is provenance and must never be substituted for this artifact digest.

The account must already have a connected BrowserContext created by the normal
session owner. The producer does not import or invoke its browser/login startup.
It makes one fixed GET to `https://www.linkedin.com/feed/` through that existing
context's request API, with normal session credentials, no redirect or retry,
no-cache headers and a four-second timeout. It does not extract cookies, create
pages, navigate an action page or explicitly change cookies. The normal context
request API can receive ordinary server session headers. It requires both the
own-profile identity card and signed-in Me navigation in fresh server markup,
then compares the canonical profile to the reviewed account identity. No provider
markup or identity is returned/logged. The already-locked `htmlparser2@8.0.2` is
declared directly for robust HTML parsing.

If LinkedIn serves only a client-rendered shell without these existing identity
markers, the operation blocks. Synthetic tests cannot establish that a real
supported session currently receives sufficient markup. Later owner-authorized
read-only acceptance must verify this seam. Playwright buffers its API response;
the producer rejects a response over 2 MiB and bounds the request time, but this
is not a transport-level streaming memory cap.

Linki sends the same exact six-key payload to `/echo/readiness` through the
configured guard URL/authentication path. The URL must exactly match reviewed
config and pass the same local-host restrictions as the action guard. Bridge
success must echo all six fields with `ready: true`. Config, manifest, scope,
runtime registration and session presence are rechecked before publishing.
There are no calls to `/echo/action` or eligibility/claim/cancellation probes.
All original action-time guard checks remain authoritative.

## Qualification and release boundary (October 9, 2026)

The producer is prepared for source review, not deployed. The existing isolated
qualification records establish:

- Parent counterpart: 54 pytest cases and Ruff passed.
- Linki: all 115 existing readiness, guard, session and connect regression cases
  passed; shared canonical-manifest integration passed two vectors/seven cases.
- Locked dependency installation with scripts disabled passed. The separately
  qualified better-sqlite3 12.6.2 binary passed Node 24.16.0 / ABI 137 / macOS arm64
  in-memory SQLite checks. These are host qualification results, not a Docker
  image or Linux native-binary qualification.
- Next 16.1.6 production build passed TypeScript, compilation, page data, static
  generation and optimization in 54.381 seconds with `experimental.cpus: 1`.
  This setting bounds page/static workers, not every compiler thread.
- Full current/copied source, dependency, native, support and provenance pins
  subsequently passed in 261.164 seconds. All 755 emitted files and 12 relative
  dependency aliases were verified before and after the C2 runtime proof.
- The actual emitted default readiness route and actual emitted instrumentation /
  executor passed five positive-mode cases and two failed-startup cases in fresh
  Node processes. Each mode loaded the route and executor in the same process
  through a thin native HTTP adapter. Runtime plus post-proof verification took
  2.191 seconds. Missing executor, missing session, ordinary workflow, wrong
  revision and actual database-startup failure all blocked as expected.

The framed build revision is
`sha256:3c42eed1e2c76040f4a82fd0fe300299883e9ab7c0482ac85e24945a1db5edaf`.
It covers the exact eleven filenames and bytes listed in `next.config.ts`,
including the permanent worker setting and explicit `never` type annotation.
Documentation and Git commits are separate provenance; they do not replace it.
The earlier 115-case result predates those two narrow type/config changes; the
final production build and emitted proof include them. No healthy batch was
repeated to prepare the PR.

C8 build receipt SHA-256:
`0bcb2285c934bd4a65473c65ef897949e11929a16167c2d2618104853df62bb7`.
C2 V4 receipt SHA-256:
`c98a13dcab6c62af966d4a86fe875657c3d46db6695a5cd4dced3902878f0224`.
The C2 peak RSS was 175,226,880 bytes; charged namespace peak was 1,419,653,120
bytes. Cleanup, all four loopback ports, owned processes, full physical
reconciliation and lease release were independently verified. The retained
build is immutable qualification evidence in the Archives validation namespace.

The conservative static inspector could not resolve a shadowed context variable
in a generated Next wrapper; that refusal is preserved. The accepted C2 proof
calls actual emitted entries but does **not** prove full Next framework dispatch.
It uses a synthetic existing BrowserContext, static own-feed HTML and a loopback
bridge fixture. Provider, browser-start, action and unexpected-fetch counters
were zero. It does **not** establish a real owner login or currently supported
LinkedIn markup.

## Minimal owner adoption proof

The paired Echo PR's `docs/READINESS_RELEASE_HANDOFF.md` defines the release
sequence. Before any runtime adoption, independently review the producer and
parent, adopt the accepted child commit in the parent gitlink, and bind the exact
clean final parent release SHA and this framed artifact revision. A normal merge
may change commit provenance without changing framed source bytes; recompute the
frame on the accepted release rather than substituting a Git SHA.

The next missing proof is one separately authorized read-only acceptance through
the normal Next HTTP dispatcher and the actual existing session owner. It must
use the preserved account store/context, reviewed exact paused workflow/list,
private config/manifest/scope and the real sibling bridge readiness route. A
fresh challenge must return the exact eight-key response, current own-profile
identity and matching artifact/manifest fields. No synthetic context, manually
preset executor evidence or authored green receipt may satisfy that check.
Record only sanitized outcome, revisions and timing, not provider markup,
cookies, secrets or private identities. If the feed lacks the required identity
markers or no connected context exists, remain blocked; login/session repair
needs separate owner authority and is not a reason to weaken the checks.

Starting the normal app invokes its existing executor and database initialization;
therefore runtime deployment/startup needs its own release authorization and
preservation plan. The readiness observation itself uses a separate readonly /
fileMustExist DB connection and does not migrate, enroll or activate workflows.
Its context request may receive ordinary server session headers, and Playwright
buffers the response before the 2 MiB check; those existing limits remain explicit.

A healthy poll-owner receipt is a separate prerequisite. The current bounce rail
is breached (1/11, 9.09%); no ready receipt, scheduler change, prospect action or
activation is authorized by this qualification. Existing action-time fencing
remains authoritative after any later readiness success.
