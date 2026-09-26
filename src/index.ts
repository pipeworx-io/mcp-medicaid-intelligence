interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/** Investor-oriented Medicaid drug utilization, managed-care, and enrollment signals. */

// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Medicaid Intelligence');
}


const BASE = 'https://data.medicaid.gov/api/1/datastore/query';
const MAX_BYTES = 5_000_000;
const DATASETS = {
  drug: {
    2020: 'cc318bfb-a9b2-55f3-a924-d47376b32ea3',
    2021: 'eec7fbe6-c4c4-5915-b3d0-be5828ef4e9d',
    2022: '200c2cba-e58d-4a95-aa60-14b99736808d',
    2023: 'd890d3a9-6b00-43fd-8b31-fcba4c8e2909',
    2024: '61729e5a-7aa8-448c-8903-ba3e0cd0ea3c',
    2025: '158a1baa-5506-400a-8ec3-97756f0b0536',
    2026: '2957a7f9-9a15-453e-9afd-3bbdcbac8fd3',
  } as Record<number, string>,
  managedSummary: '52ed908b-0cb8-5dd2-846d-99d4af12b369',
  managedPrograms: 'e2ce0d2f-07c5-5213-947a-31e19bc649f6',
  plans: '0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe',
  monthlyManaged: '89baf100-259b-4763-b9e2-337972f988c4',
  enrollment: '6165f45b-ca93-5bb5-9d06-db29c692a360',
};

/**
 * A caller mistake we can describe precisely. Carries the machine-readable reason and the
 * hint that `callTool` turns into `{found:false, ...}`, so a bad argument comes back as
 * something an agent can act on rather than as an exception that reads like our outage.
 */
class InputError extends Error {
  constructor(
    readonly reason: string,
    readonly hint: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(hint);
    this.name = 'InputError';
  }
}

const listSchema = (key: string) => ({
  type: 'object', properties: {
    total: { type: 'number' }, returned: { type: 'number' },
    [key]: { type: 'array', items: { type: 'object' } },
    source: { type: 'string' }, interpretation: { type: 'string' },
  }, required: ['total', 'returned', key, 'source', 'interpretation'],
});

const tools: McpToolExport['tools'] = [
  {
    name: 'medicaid_drug_utilization',
    description: 'Quarterly state-level Medicaid utilization rows for a drug — prescriptions, units and reimbursement per state and quarter, separated into fee-for-service and managed care. Ask by NAME ("Ozempic") or by an exact 11-digit NDC. Reimbursement is gross before Medicaid rebates and is not manufacturer revenue or net price.',
    inputSchema: { type: 'object', properties: {
      drug: { type: 'string', description: 'Drug name as it appears on the package, e.g. "Ozempic" or "Humira" — matched against the Medicaid product list, aggregating every package size. A generic ingredient is expanded to its NDCs automatically when Medicaid lists it only under brands.' },
      ndc: { type: 'string', description: 'Exact 11-digit National Drug Code, hyphenated or not, e.g. "00002-1433-80". Optional — give this OR drug. An NDC narrows to one package size.' },
      year: { type: 'number', description: 'Calendar year 2020-2026. Defaults to the most recent year with data.' },
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      utilization_type: { type: 'string', enum: ['FFS', 'Managed Care'], description: 'Restrict to fee-for-service or managed-care records; omit for both.' },
      limit: { type: 'number' }, offset: { type: 'number' },
    }, required: [] },
    outputSchema: listSchema('records'),
  },
  {
    name: 'medicaid_drug_state_market',
    description: 'Which states spend the most on a drug — one year of Medicaid reimbursement broken down by state, keeping fee-for-service and managed care separate. Ask by NAME ("Ozempic") or by an exact 11-digit NDC. Suppressed rows remain unavailable and totals are gross pharmacy reimbursement before rebates.',
    inputSchema: { type: 'object', properties: {
      drug: { type: 'string', description: 'Drug name as it appears on the package, e.g. "Ozempic" or "Humira" — matched against the Medicaid product list, aggregating every package size. A generic ingredient is expanded to its NDCs automatically when Medicaid lists it only under brands.' },
      ndc: { type: 'string', description: 'Exact 11-digit National Drug Code, hyphenated or not, e.g. "00002-1433-80". Optional — give this OR drug. An NDC narrows to one package size.' },
      year: { type: 'number', description: 'Calendar year 2020-2026. Defaults to the most recent year with data.' },
    }, required: [] },
    outputSchema: listSchema('states'),
  },
  {
    name: 'medicaid_drug_trend',
    description: 'How much Medicaid spent on a drug, year by year — annual prescriptions, units and gross reimbursement from 2020 onward, split between fee-for-service and managed care. Ask by NAME ("Ozempic", "Humira"): the name is matched against the Medicaid product list and aggregated across every package size, so this answers "how much did Medicaid spend on X" directly. An exact 11-digit NDC narrows to one package instead. Reimbursement is GROSS, before the rebates Medicaid negotiates, so it is not manufacturer revenue or net cost to the programme. Suppressed values are never converted to zero.',
    inputSchema: { type: 'object', properties: {
      drug: { type: 'string', description: 'Drug name as it appears on the package, e.g. "Ozempic" or "Humira" — matched against the Medicaid product list, aggregating every package size. A generic ingredient is expanded to its NDCs automatically when Medicaid lists it only under brands.' },
      ndc: { type: 'string', description: 'Exact 11-digit National Drug Code, hyphenated or not, e.g. "00002-1433-80". Optional — give this OR drug. An NDC narrows to one package size.' },
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      from_year: { type: 'number', description: 'First calendar year, 2020 or later. Defaults to 2024 — pass an earlier year for a longer history.' },
      to_year: { type: 'number', description: 'Last calendar year, 2026 or earlier.' },
    }, required: [] },
    // `ndc` is NOT required, and used to be: a name lookup ("Ozempic") resolves to a
    // product-name filter and legitimately returns no single NDC, so the declared
    // contract failed on the tool's own primary path. `matched_by` is the field that
    // is always present, and it is what tells a caller which of the two happened.
    outputSchema: { type: 'object', properties: {
      ndc: { type: 'string', description: 'Present only when the call was matched on an exact NDC.' },
      drug: { type: 'string' },
      matched_by: { type: 'string', description: 'ndc | product_name | ndc_expansion.' },
      state: { type: ['string', 'null'] },
      years: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['matched_by', 'years', 'source', 'interpretation'] },
  },
  {
    name: 'medicaid_managed_care_summary',
    description: 'Show annual state Medicaid enrollment and enrollment in any or comprehensive managed care. Counts are state-reported program enrollment, not covered lives attributable to a particular insurer.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California"). Omit for national totals.' },
      from_year: { type: 'number' }, to_year: { type: 'number' },
    }},
    outputSchema: listSchema('years'),
  },
  {
    name: 'medicaid_managed_care_program_mix',
    description: 'Show state Medicaid enrollment by managed-care program type, including comprehensive MCO, PCCM, MLTSS, behavioral health, dental, transportation, and PACE. Program counts overlap and must not be summed.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      year: { type: 'number', description: 'Calendar year; omit for every year published.' },
    }, required: ['state'] },
    outputSchema: listSchema('years'),
  },
  {
    name: 'medicaid_plan_market',
    description: 'Return a bounded API-order sample of Medicaid managed-care plan/program rows by state and optional year, with the authoritative matching-row count. Zero may represent confidentiality suppression in this source.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', description: 'Full state name.' }, year: { type: 'number' },
      parent_organization: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['state'] },
    outputSchema: listSchema('plans'),
  },
  {
    name: 'medicaid_monthly_managed_care',
    description: 'Show monthly Medicaid/CHIP enrollment for one state and managed-care participation category. Data-quality flags and confidentiality suppression are preserved.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      participation: { type: 'string', description: 'Exact CMS category, e.g. "Comprehensive managed care".' },
      from_month: { type: 'string', description: 'YYYYMM.' }, to_month: { type: 'string', description: 'YYYYMM.' },
    }, required: ['state', 'participation'] },
    outputSchema: listSchema('months'),
  },
  {
    name: 'medicaid_enrollment_operations',
    description: 'Show monthly Medicaid and CHIP enrollment and application-processing indicators for one state. Values are preliminary or updated state reports and may include footnotes or missing periods.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      from_month: { type: 'string', description: 'YYYYMM.' }, to_month: { type: 'string', description: 'YYYYMM.' },
    }, required: ['state'] },
    outputSchema: listSchema('months'),
  },
];

/**
 * A caller mistake, returned in the SAME shape as an answer.
 *
 * `found:false` is worth keeping — it is the one field an agent can branch on without
 * parsing prose — but a bare `{found:false, reason, hint}` carried none of the fields
 * this tool's own `outputSchema` marks required, so a strict MCP client rejected the
 * whole call with -32602. The gateway never saw it: no `error` key means no
 * `isError`, so we booked `success` while the client threw. That class of bug is
 * invisible to every error metric we have, which is why it reached users twice.
 *
 * So fill the required fields with their empty values and put the explanation in
 * `interpretation`, then keep `found:false`/`reason`/`hint` alongside. Nothing is
 * lost: a caller that only handles the answer shape sees an honest empty result, and
 * a caller that checks `found` still gets the machine-readable reason.
 *
 * Built from the tool's own declared schema rather than a hand-written per-tool
 * literal, so the two cannot drift apart — the whole failure here was a second
 * shape that nobody kept in step with the first.
 */
function conformantMiss(
  name: string,
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const schema = tools.find((t) => t.name === name)?.outputSchema as
    | { properties?: Record<string, { type?: unknown }>; required?: string[] }
    | undefined;
  const out: Record<string, unknown> = {};
  for (const key of schema?.required ?? []) {
    const declared = schema?.properties?.[key]?.type;
    const type = Array.isArray(declared) ? declared[0] : declared;
    out[key] = type === 'array' ? [] : type === 'number' ? 0 : type === 'string' ? '' : null;
  }
  // The two string fields that must say something true rather than be blank.
  if ('source' in out) out.source = name.startsWith('medicaid_drug_') ? drugSource() : enrollmentSource();
  if ('interpretation' in out) out.interpretation = hint;
  return { ...out, found: false, reason, hint, ...extra };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'medicaid_drug_utilization': return await drugUtilization(args);
      case 'medicaid_drug_state_market': return await drugStateMarket(args);
      case 'medicaid_drug_trend': return await drugTrend(args);
      case 'medicaid_managed_care_summary': return await managedSummary(args);
      case 'medicaid_managed_care_program_mix': return await managedProgramMix(args);
      case 'medicaid_plan_market': return await planMarket(args);
      case 'medicaid_monthly_managed_care': return await monthlyManagedCare(args);
      case 'medicaid_enrollment_operations': return await enrollmentOperations(args);
      default:
        return conformantMiss(name, 'unknown_tool',
          `medicaid-intelligence exposes ${tools.map((t) => t.name).join(', ')}.`,
          { requested_tool: name });
    }
  } catch (err) {
    // A caller mistake is recoverable and says so; anything else is ours or the upstream's
    // and is reported as an error, so the golden suite can tell the two apart.
    if (err instanceof InputError) {
      return conformantMiss(name, err.reason, err.hint, err.extra);
    }
    const message = err instanceof Error ? err.message : String(err);
    // Keep any class routing token at the FRONT of the string. `stripClassPrefix`
    // and the classifier both anchor on `^`, so prepending "pack/tool: " to a
    // message that starts with `user_error:` does two bad things at once: the
    // error silently books as `error` (i.e. "Pipeworx has a defect") instead of
    // as the caller mistake it is, AND the raw token leaks into what the caller
    // reads. Hoist it out, wrap the rest, put it back on the front.
    const token = message.match(/^(?:upstream_down|upstream_throttled|user_error)\s*:\s*/)?.[0] ?? '';
    const body = message.slice(token.length);
    return {
      error: `${token}medicaid-intelligence/${name}: ${body}`,
      hint: /exceeded the bounded|size limit/i.test(message)
        ? 'The result set is larger than this tool returns in one call. Narrow it with `state`, `year` or a month range, or page with `limit` and `offset`.'
        : /timeout|abort|fetch failed/i.test(message)
          ? 'data.medicaid.gov did not respond in time. Retry once; if it persists, narrow the query.'
          : 'The CMS Medicaid Open Data API refused the request or changed shape. Retry once; if it persists the dataset may have been reissued under a new id.',
    };
  }
}

/**
 * Every drug tool here required an exact 11-digit NDC and told the caller to go
 * resolve one elsewhere. Nobody asking "how much did Medicaid spend on Ozempic"
 * has an NDC, and the router said so in as many words: "no available tool can
 * answer ... without first resolving the brand name to an exact 11-digit NDC,
 * and no NDC-resolution tool is provided". Meanwhile the one question that
 * "passed" only did so because the model guessed an NDC from memory, and every
 * year of it came back zero — an empty answer wearing the shape of a real one.
 *
 * The dataset carries `product_name`, so a brand resolves in the same request
 * with no extra round trip. A generic name often does NOT appear there
 * (Medicaid lists semaglutide only as Ozempic/Wegovy/Rybelsus), so that case
 * falls back to expanding the name to NDCs via RxNav and matching those.
 */
const RXNAV = 'https://rxnav.nlm.nih.gov/REST';

async function ndcsForName(name: string): Promise<string[]> {
  const idRes = await pwFetch(`${RXNAV}/rxcui.json?name=${encodeURIComponent(name)}`);
  if (!idRes.ok) return [];
  const seed = ((await idRes.json()) as { idGroup?: { rxnormId?: string[] } }).idGroup?.rxnormId?.[0];
  if (!seed) return [];
  const relRes = await pwFetch(`${RXNAV}/rxcui/${seed}/related.json?tty=SCD+SBD`);
  if (!relRes.ok) return [];
  const products = ((await relRes.json()) as {
    relatedGroup?: { conceptGroup?: { conceptProperties?: { rxcui: string }[] }[] };
  }).relatedGroup?.conceptGroup?.flatMap((g) => g.conceptProperties ?? []) ?? [];
  // Bounded: this is a resolution step, not the answer.
  const lists = await Promise.all(products.slice(0, 20).map(async (p) => {
    const r = await pwFetch(`${RXNAV}/rxcui/${p.rxcui}/ndcs.json`).catch(() => null);
    if (!r?.ok) return [];
    return ((await r.json()) as { ndcGroup?: { ndcList?: { ndc?: string[] } } }).ndcGroup?.ndcList?.ndc ?? [];
  }));
  return [...new Set(lists.flat())].slice(0, 50);
}

interface DrugFilter { condition: Condition; matched_by: string; drug?: string; ndcs_matched?: number }

async function resolveDrugFilter(args: Record<string, unknown>, year: number): Promise<DrugFilter> {
  const rawNdc = String(args.ndc ?? '').trim();
  const drug = String(args.drug ?? '').trim();
  if (rawNdc) return { condition: eq('ndc', ndcArg(args.ndc)), matched_by: 'ndc' };
  if (!drug) {
    throw new Error('user_error: Give a drug name ("Ozempic") or an exact 11-digit ndc. A name is resolved against the Medicaid product list for you.');
  }

  const probe = await query(DATASETS.drug[year], [like('product_name', drug.toUpperCase())], 1);
  if (probe.results.length) return { condition: like('product_name', drug.toUpperCase()), matched_by: 'product_name', drug };

  const ndcs = await ndcsForName(drug);
  if (ndcs.length) return { condition: oneOf('ndc', ndcs), matched_by: 'ndc_expansion', drug, ndcs_matched: ndcs.length };

  throw new Error(`user_error: No Medicaid drug record matches "${drug}". Medicaid lists products under the name on the package, so a generic ingredient may only appear under its brands (semaglutide is listed as Ozempic, Wegovy and Rybelsus). Try the brand, or pass an exact 11-digit ndc.`);
}

async function drugUtilization(args: Record<string, unknown>) {
  const year = drugYear(args.year);
  const filter = await resolveDrugFilter(args, year);
  const conditions: Condition[] = [filter.condition];
  const state = optionalState(args.state);
  if (state) conditions.push(eq('state', state));
  const type = utilizationType(args.utilization_type);
  if (type) conditions.push(eq('utilization_type', type));
  const payload = await query(DATASETS.drug[year], conditions, intArg(args.limit, 100, 1, 500), intArg(args.offset, 0, 0, 100_000));
  return {
    total: payload.count, returned: payload.results.length, records: payload.results.map(projectDrug),
    ...drugMatch(filter), year, state: state ?? null, source: drugSource(), interpretation: drugInterpretation(),
  };
}

async function drugStateMarket(args: Record<string, unknown>) {
  const year = drugYear(args.year);
  const filter = await resolveDrugFilter(args, year);
  const payload = await queryAll(DATASETS.drug[year], [filter.condition]);
  const truncated = !payload.complete;
  const grouped = groupDrug(payload.results, 'state');
  return {
    total: grouped.length, returned: grouped.length, states: grouped, ...drugMatch(filter), year,
    ...(truncated ? {
      truncated: true,
      note: `Read ${payload.results.length} of ${payload.count} matching rows, so these state totals understate the market. Narrow with an exact ndc, or read one state at a time.`,
    } : {}),
    source: drugSource(), interpretation: drugInterpretation(),
  };
}

async function drugTrend(args: Record<string, unknown>) {
  const state = optionalState(args.state);
  // Default to the most recent three years rather than all seven. Each year now
  // pages to exhaustion for a complete total, and seven of those took ~24s local
  // plus routing overhead — enough to hit the caller's 45s ceiling and return
  // nothing at all, which is how this ticket started. Three years answers the
  // spend question and stays well inside budget; from_year reaches back further.
  const [from, to] = yearRange(args, 2020, 2026, 7, 2024);
  // Resolve ONCE against the latest year in range, then reuse: resolving per
  // year would multiply a name lookup across seven parallel fan-outs.
  const filter = await resolveDrugFilter(args, to);
  // Bound the WHOLE trend, not just each year. A high-volume drug over a long
  // span (Humira runs ~2,600 rows a year against Ozempic's ~1,400) otherwise
  // multiplies out past the caller's 45s ceiling and returns nothing at all —
  // which is worse than a disclosed partial. Spread a fixed page budget across
  // the requested years; a short span still reads every row.
  const perYearPages = Math.max(2, Math.floor(TREND_PAGE_BUDGET / (to - from + 1)));
  const years = await Promise.all(Array.from({ length: to - from + 1 }, (_, index) => from + index).map(async (year) => {
    const conditions = [filter.condition];
    if (state) conditions.push(eq('state', state));
    const payload = await queryAll(DATASETS.drug[year], conditions, perYearPages);
    return {
      year, ...aggregateDrug(payload.results),
      suppressed_rows: payload.results.filter(isSuppressed).length,
      rows_read: payload.results.length, matching_rows: payload.count,
      // A year over the paging bound used to throw and kill the whole trend.
      // Report the shortfall for that year instead of losing the other six.
      ...(payload.complete ? {} : {
        truncated: true,
        note: `Read ${payload.results.length} of ${payload.count} matching rows, so this year's totals understate. Narrow by state or by an exact ndc for a complete figure.`,
      }),
    };
  }));
  return { ...drugMatch(filter), state: state ?? null, years, source: drugSource(), interpretation: drugInterpretation() };
}

/** Say what the name was matched against, so an aggregate is never mistaken for one product. */
function drugMatch(filter: DrugFilter) {
  return {
    ...(filter.drug ? { drug: filter.drug } : {}),
    ...(filter.matched_by === 'ndc' ? { ndc: (filter.condition.value as string) } : {}),
    matched_by: filter.matched_by,
    ...(filter.ndcs_matched ? { ndcs_matched: filter.ndcs_matched } : {}),
    ...(filter.matched_by !== 'ndc' ? {
      match_note: filter.matched_by === 'product_name'
        ? `Aggregated across every Medicaid product whose name contains "${filter.drug}", which spans all package sizes and presentations of it.`
        : `"${filter.drug}" is not a Medicaid product name, so it was expanded to ${filter.ndcs_matched} NDCs via RxNorm and matched on those.`,
    } : {}),
  };
}

async function managedSummary(args: Record<string, unknown>) {
  const state = args.state == null ? 'TOTALS' : stateName(args.state);
  const payload = await query(DATASETS.managedSummary, [eq('state', state)], 100);
  const years = rangeRows(payload.results, args).map((row) => ({
    year: numberValue(row.year), total_medicaid_enrollees: nullableCount(row.total_medicaid_enrollees),
    any_managed_care_enrollment: nullableCount(row.total_medicaid_enrollment_in_any_type_of_managed_care),
    comprehensive_managed_care_enrollment: nullableCount(row.medicaid_enrollment_in_comprehensive_managed_care),
    comprehensive_managed_care_share: ratio(row.medicaid_enrollment_in_comprehensive_managed_care, row.total_medicaid_enrollees),
    notes: nullableText(row.notes),
  }));
  return {
    total: years.length, returned: years.length, years, state,
    source: enrollmentSource(), interpretation: managedInterpretation(),
  };
}

async function managedProgramMix(args: Record<string, unknown>) {
  const state = stateName(requiredString(args, 'state'));
  const conditions = [eq('state', state)];
  if (args.year != null) conditions.push(eq('year', integerString(args.year, 'year')));
  const payload = await query(DATASETS.managedPrograms, conditions, 100);
  const years = payload.results.sort((a, b) => numberValue(a.year) - numberValue(b.year)).map((row) => ({
    year: numberValue(row.year), total_medicaid_enrollees: nullableCount(row.total_medicaid_enrollees),
    comprehensive_mco: nullableCount(row.comprehensive_mco_with_or_without_mltss),
    pccm: nullableCount(row.pccm), pccm_entity: nullableCount(row.pccm_entity),
    mltss_only: nullableCount(row.mltss_only), behavioral_health: nullableCount(row.bho_pihp_andor_pahp),
    dental: nullableCount(row.dental), transportation: nullableCount(row.transportation),
    pace: nullableCount(row.pace), other: nullableCount(row.other), notes: nullableText(row.notes),
  }));
  return {
    total: years.length, returned: years.length, years, state,
    source: enrollmentSource(),
    interpretation: `${managedInterpretation()} Program categories can overlap, so their counts must not be summed.`,
  };
}

async function planMarket(args: Record<string, unknown>) {
  const state = stateName(requiredString(args, 'state'));
  const conditions = [eq('state', state)];
  if (args.year != null) conditions.push(eq('year', integerString(args.year, 'year')));
  const parent = stringArg(args.parent_organization);
  if (parent) conditions.push(eq('parent_organization', parent));
  const payload = await query(DATASETS.plans, conditions, intArg(args.limit, 50, 1, 200), intArg(args.offset, 0, 0, 20_000));
  const plans = payload.results.map((row) => ({
    state: row.state, year: nullableCount(row.year), program_name: row.program_name, plan_name: row.plan_name,
    parent_organization: row.parent_organization || null, geographic_region: row.geographic_region || null,
    medicaid_only_enrollment: nullableCount(row.medicaidonly_enrollment),
    dual_enrollment: nullableCount(row.dual_enrollment), total_enrollment: nullableCount(row.total_enrollment),
    suppression_caveat: 'Reported zero may represent a state confidentiality suppression.',
  }));
  return {
    total: payload.count, returned: plans.length, plans, state, source: enrollmentSource(),
    interpretation: 'total is the authoritative matching-row count; plans is a bounded API-order sample, not a ranking. Enrollment is point-in-time program reporting, and reported zero can represent confidentiality suppression rather than a true zero.',
  };
}

async function monthlyManagedCare(args: Record<string, unknown>) {
  const state = requiredString(args, 'state'), participation = requiredString(args, 'participation');
  const payload = await query(DATASETS.monthlyManaged, [eq('state', state), eq('managedcare_participation', participation)], 500);
  if (payload.count > 500) throw new Error('user_error: Monthly managed-care query exceeded the bounded 500-row limit');
  const months = monthRows(payload.results, args).map((row) => ({
    month: row.month, enrollment: nullableCount(row.countenrolled),
    data_quality: row.dunusable || null, suppressed: isSuppressedValue(row.countenrolled),
  }));
  return {
    total: months.length, returned: months.length, months, state, participation,
    source: enrollmentSource(),
    interpretation: 'Counts are Medicaid/CHIP enrollment for the selected participation category, not unique people across categories. DS and unavailable values remain null; data-quality flags should be reviewed before comparison.',
  };
}

async function enrollmentOperations(args: Record<string, unknown>) {
  const state = stateCode(requiredString(args, 'state'));
  const payload = await query(DATASETS.enrollment, [eq('state_abbreviation', state)], 500);
  if (payload.count > 500) throw new Error('user_error: Enrollment operations query exceeded the bounded 500-row limit');
  const months = monthRows(payload.results.map((row) => ({ ...row, month: row.reporting_period })), args).map((row) => ({
    month: row.reporting_period, preliminary_or_updated: row.preliminary_or_updated,
    final_report: row.final_report === 'Y', medicaid_and_chip_enrollment: nullableCount(row.total_medicaid_and_chip_enrollment),
    medicaid_enrollment: nullableCount(row.total_medicaid_enrollment), chip_enrollment: nullableCount(row.total_chip_enrollment),
    adult_medicaid_enrollment: nullableCount(row.total_adult_medicaid_enrollment),
    child_medicaid_and_chip_enrollment: nullableCount(row.medicaid_and_chip_child_enrollment),
    applications_to_medicaid_and_chip_agencies: nullableCount(row.new_applications_submitted_to_medicaid_and_chip_agencies),
  }));
  return {
    total: months.length, returned: months.length, months, state,
    source: enrollmentSource(),
    interpretation: 'These are state-reported monthly operational indicators. Preliminary and updated reports, missing fields, methodology changes, and accompanying CMS footnotes can affect comparisons.',
  };
}

type Row = Record<string, unknown>;
interface Condition { property: string; value: string | string[]; operator: '=' | 'like' | 'in' }
interface QueryResult { count: number; results: Row[] }
const eq = (property: string, value: string): Condition => ({ property, value, operator: '=' });
const like = (property: string, value: string): Condition => ({ property, value: `%${value}%`, operator: 'like' });
const oneOf = (property: string, value: string[]): Condition => ({ property, value, operator: 'in' });

/**
 * A spend question wants a TOTAL, and one 500-row read of a 1,400-row year is
 * not one — it is a fraction presented as an answer. Page until the match set is
 * exhausted, bounded so a broad name cannot run away.
 */
const PAGE = 500;
const MAX_PAGES = 8;
// Sized from the real shape of the data, not a guess: the heaviest drug seen
// (Humira) runs ~3,200 rows in its worst year, so ~7 pages, and a full 2020-2026
// span needs ~45. At 56 the per-year allowance over the widest span equals
// MAX_PAGES, so every realistic drug completes, and the worst case is still a
// hard 56 requests — measured at ~7s live for exactly that query. Too tight a
// budget is not free: at 24 a seven-year Humira read halved its own spend total
// and merely said so.
const TREND_PAGE_BUDGET = 56;

async function queryAll(dataset: string, conditions: Condition[], maxPages = MAX_PAGES): Promise<QueryResult & { complete: boolean }> {
  const first = await query(dataset, conditions, PAGE);
  const rows = [...first.results];
  const pages = Math.min(maxPages, Math.ceil(first.count / PAGE));
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => query(dataset, conditions, PAGE, (i + 1) * PAGE)),
    );
    for (const page of rest) rows.push(...page.results);
  }
  return { count: first.count, results: rows, complete: rows.length >= first.count };
}

async function query(dataset: string, conditions: Condition[], limit: number, offset = 0): Promise<QueryResult> {
  const url = new URL(`${BASE}/${dataset}/0`);
  url.searchParams.set('limit', String(limit));
  if (offset) url.searchParams.set('offset', String(offset));
  conditions.forEach((condition, index) => {
    url.searchParams.set(`conditions[${index}][property]`, condition.property);
    if (Array.isArray(condition.value)) {
      // An `in` takes a repeated value[] parameter, not a comma-joined string.
      for (const item of condition.value) url.searchParams.append(`conditions[${index}][value][]`, item);
    } else {
      url.searchParams.set(`conditions[${index}][value]`, condition.value);
    }
    url.searchParams.set(`conditions[${index}][operator]`, condition.operator);
  });
  const response = await pwFetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw await httpError(response, 'Medicaid Open Data API failed');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('Medicaid response exceeded size limit');
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Medicaid response exceeded size limit');
  const payload = JSON.parse(text) as { count?: unknown; results?: unknown };
  const results = Array.isArray(payload.results) ? payload.results.filter((row): row is Row =>
    !!row && typeof row === 'object' && !Array.isArray(row)) : [];
  return { count: numberValue(payload.count), results };
}

const projectDrug = (row: Row) => ({
  utilization_type: row.utilization_type === 'FFSU' ? 'Fee for Service' : row.utilization_type === 'MCOU' ? 'Managed Care' : row.utilization_type,
  state: row.state, ndc: row.ndc, product_name: String(row.product_name ?? '').trim() || null,
  year: nullableCount(row.year), quarter: nullableCount(row.quarter), suppressed: isSuppressed(row),
  units_reimbursed: nullableCount(row.units_reimbursed), prescriptions: nullableCount(row.number_of_prescriptions),
  total_amount_reimbursed: nullableCount(row.total_amount_reimbursed),
  medicaid_amount_reimbursed: nullableCount(row.medicaid_amount_reimbursed),
  non_medicaid_amount_reimbursed: nullableCount(row.non_medicaid_amount_reimbursed),
});

function groupDrug(rows: Row[], key: string) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const value = String(row[key] ?? '');
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, values]) => ({
    [key]: value, ...aggregateDrug(values), suppressed_rows: values.filter(isSuppressed).length,
  }));
}

function aggregateDrug(rows: Row[]) {
  const byType = (code: string) => {
    const selected = rows.filter((row) => row.utilization_type === code && !isSuppressed(row));
    const sum = (field: string) => selected.reduce((total, row) => total + (nullableCount(row[field]) ?? 0), 0);
    return {
      reported_rows: selected.length,
      prescriptions: selected.length ? sum('number_of_prescriptions') : null,
      units_reimbursed: selected.length ? sum('units_reimbursed') : null,
      total_amount_reimbursed: selected.length ? sum('total_amount_reimbursed') : null,
      medicaid_amount_reimbursed: selected.length ? sum('medicaid_amount_reimbursed') : null,
    };
  };
  return { fee_for_service: byType('FFSU'), managed_care: byType('MCOU') };
}

function rangeRows(rows: Row[], args: Record<string, unknown>) {
  const available = rows.map((row) => numberValue(row.year)).filter(Number.isInteger);
  if (!available.length) return [];
  const [from, to] = yearRange(args, Math.min(...available), Math.max(...available), 20);
  return rows.filter((row) => numberValue(row.year) >= from && numberValue(row.year) <= to)
    .sort((a, b) => numberValue(a.year) - numberValue(b.year));
}

function monthRows(rows: Row[], args: Record<string, unknown>) {
  const from = monthArg(args.from_month, '000000'), to = monthArg(args.to_month, '999999');
  if (from > to) throw new Error('user_error: from_month must not be after to_month');
  return rows.filter((row) => String(row.month ?? '') >= from && String(row.month ?? '') <= to)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

function yearRange(args: Record<string, unknown>, min: number, max: number, maxSpan: number, defaultFrom = min): [number, number] {
  const from = args.from_year == null ? defaultFrom : Number(args.from_year);
  const to = args.to_year == null ? max : Number(args.to_year);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to || to - from + 1 > maxSpan) {
    throw new Error(`user_error: year range must be ascending within ${min}-${max} and span at most ${maxSpan} years`);
  }
  return [from, to];
}

function drugYear(value: unknown) {
  const year = value == null ? 2025 : Number(value);
  if (!Number.isInteger(year) || !DATASETS.drug[year]) throw new Error('user_error: year must be from 2020 through 2026');
  return year;
}
function ndcArg(value: unknown) {
  const raw = String(value ?? '').trim();
  const ndc = raw.replace(/\D/g, '');
  if (ndc.length !== 11) {
    // A drug name is the most likely thing an agent passes here, and it is recoverable —
    // say where an NDC comes from instead of only restating the format rule.
    const looksLikeName = /[a-z]/i.test(raw);
    throw new InputError(
      looksLikeName ? 'ndc_expected_got_name' : 'ndc_malformed',
      looksLikeName
        ? `"${raw}" looks like a drug name; this dataset is keyed on an 11-digit NDC. Resolve the name to an NDC first — openfda_drug_label or rxnorm return NDCs for a brand or ingredient — then call again, e.g. ndc="00002143380".`
        : `NDC must be 11 digits; "${raw}" has ${ndc.length}. Hyphenated 5-4-2 form is fine ("00002-1433-80"). A 10-digit NDC from a package label needs a leading zero added to the correct segment.`,
      { requested_ndc: raw, digits_found: ndc.length },
    );
  }
  return ndc;
}
function utilizationType(value: unknown) {
  if (value == null) return null;
  if (value === 'FFS') return 'FFSU';
  if (value === 'Managed Care') return 'MCOU';
  throw new Error('user_error: utilization_type must be FFS or Managed Care');
}
function isSuppressed(row: Row) { return String(row.suppression_used).toLowerCase() === 'true'; }
function isSuppressedValue(value: unknown) { return ['DS', '*', '--'].includes(String(value ?? '').trim().toUpperCase()); }
function nullableCount(value: unknown): number | null {
  if (value == null || value === '' || isSuppressedValue(value)) return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function nullableText(value: unknown) {
  const text = String(value ?? '').trim();
  return !text || isSuppressedValue(text) ? null : text;
}
function ratio(numerator: unknown, denominator: unknown) {
  const n = nullableCount(numerator), d = nullableCount(denominator);
  return n === null || d === null || d === 0 ? null : n / d;
}
/**
 * These datasets disagree about how a state is written: the drug files use two-letter
 * codes, the enrollment and managed-care files use full names. Agents pass whichever they
 * have. Accept both everywhere and convert, because the alternative is worse than an
 * error — asking the managed-care summary for "CA" matched nothing and returned a
 * confident `total: 0`, which reads as "California has no managed care".
 */
const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', VI: 'Virgin Islands', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toUpperCase(), code]),
);

/** Two-letter code for the drug datasets, from either a code or a full name. */
function stateCode(value: unknown): string {
  const raw = String(value ?? '').trim();
  const upper = raw.toUpperCase();
  if (STATE_NAMES[upper]) return upper;
  if (STATE_CODES[upper]) return STATE_CODES[upper];
  throw new InputError(
    'state_unrecognised',
    `"${raw}" is not a US state. Pass either a two-letter code ("CA") or a full name ("California") — both work.`,
    { requested_state: raw },
  );
}

/** Full state name for the enrollment and managed-care datasets, from either form. */
function stateName(value: unknown): string {
  const code = stateCode(value);
  return STATE_NAMES[code];
}

function optionalState(value: unknown) {
  if (value == null) return null;
  return stateCode(value);
}
function monthArg(value: unknown, fallback: string) {
  if (value == null) return fallback;
  const month = String(value);
  if (!/^\d{6}$/.test(month) || Number(month.slice(4)) < 1 || Number(month.slice(4)) > 12) throw new Error('user_error: month must use YYYYMM');
  return month;
}
function integerString(value: unknown, key: string) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`user_error: ${key} must be an integer`);
  return String(number);
}
function numberValue(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function stringArg(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function requiredString(args: Record<string, unknown>, key: string) {
  const value = stringArg(args[key]); if (!value) throw new Error(`user_error: ${key} is required`); return value;
}
function intArg(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
function drugSource() { return 'CMS data.medicaid.gov State Drug Utilization Data'; }
function enrollmentSource() { return 'CMS data.medicaid.gov Medicaid and CHIP enrollment datasets'; }
function drugInterpretation() {
  return 'Utilization rows are state-reported covered outpatient drug reimbursements. Total reimbursement is gross before Medicaid Drug Rebate Program rebates and is not manufacturer revenue, net price, profit, total US prescriptions, or unique patients. Suppressed rows remain unavailable rather than zero.';
}
function managedInterpretation() {
  return 'Counts are state-reported Medicaid enrollment. They do not establish insurer market share, utilization, revenue, or unique enrollment across overlapping managed-care program categories; review notes and methodology before cross-state comparison.';
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
