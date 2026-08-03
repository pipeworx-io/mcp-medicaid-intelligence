interface McpToolDefinition {
  name: string;
  description: string;
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
  return new Error(`${name}: ${res.status}${detailSuffix(await readDetail(res))}`);
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  return `${name}: ${res.status}${detailSuffix(await readDetail(res))}`;
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
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an HTML page instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `First 120 chars: ${collapse(raw).slice(0, 120)}`,
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
  if (!raw) return '';

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) carries no API-level explanation, only markup that would crowd out
  // the status. Recognising it is worth more than stripping it: dropping it
  // keeps the message honest instead of filling it with `<!DOCTYPE html><html>`.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) return '';

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return collapse(fromJson ?? raw).slice(0, MAX_DETAIL);
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
    description: 'Return quarterly state Medicaid utilization rows for an exact 11-digit NDC, separated into fee-for-service and managed-care records. Reimbursement is gross before Medicaid rebates and is not manufacturer revenue or net price.',
    inputSchema: { type: 'object', properties: {
      ndc: { type: 'string', description: 'Exact 11-digit National Drug Code, hyphenated or not, e.g. "00002-1433-80" or "00002143380". Resolve a brand or ingredient name to an NDC first with openfda_drug_label or rxnorm.' },
      year: { type: 'number', description: 'Calendar year 2020-2026. Defaults to the most recent year with data.' },
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      utilization_type: { type: 'string', enum: ['FFS', 'Managed Care'], description: 'Restrict to fee-for-service or managed-care records; omit for both.' },
      limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['ndc'] },
    outputSchema: listSchema('records'),
  },
  {
    name: 'medicaid_drug_state_market',
    description: 'Aggregate one exact NDC across states for a year, keeping fee-for-service and managed-care measures separate. Suppressed rows remain unavailable and totals are gross pharmacy reimbursement before rebates.',
    inputSchema: { type: 'object', properties: {
      ndc: { type: 'string', description: 'Exact 11-digit National Drug Code, hyphenated or not, e.g. "00002-1433-80" or "00002143380". Resolve a brand or ingredient name to an NDC first with openfda_drug_label or rxnorm.' },
      year: { type: 'number', description: 'Calendar year 2020-2026. Defaults to the most recent year with data.' },
    }, required: ['ndc'] },
    outputSchema: listSchema('states'),
  },
  {
    name: 'medicaid_drug_trend',
    description: 'Show annual Medicaid prescription, unit, and gross reimbursement trends for an exact 11-digit NDC from 2020 onward, split between fee-for-service and managed care. Suppressed values are never converted to zero.',
    inputSchema: { type: 'object', properties: {
      ndc: { type: 'string', description: 'Exact 11-digit National Drug Code, hyphenated or not, e.g. "00002-1433-80" or "00002143380". Resolve a brand or ingredient name to an NDC first with openfda_drug_label or rxnorm.' },
      state: { type: 'string', description: 'US state, as a two-letter code ("CA") or a full name ("California") — both are accepted.' },
      from_year: { type: 'number', description: 'First calendar year, 2020 or later.' },
      to_year: { type: 'number', description: 'Last calendar year, 2026 or earlier.' },
    }, required: ['ndc'] },
    outputSchema: { type: 'object', properties: {
      ndc: { type: 'string' }, years: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['ndc', 'years', 'source', 'interpretation'] },
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
        return {
          found: false,
          reason: 'unknown_tool',
          hint: `medicaid-intelligence exposes ${tools.map((t) => t.name).join(', ')}.`,
          requested_tool: name,
        };
    }
  } catch (err) {
    // A caller mistake is recoverable and says so; anything else is ours or the upstream's
    // and is reported as an error, so the golden suite can tell the two apart.
    if (err instanceof InputError) {
      return { found: false, reason: err.reason, hint: err.hint, ...err.extra };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `medicaid-intelligence/${name}: ${message}`,
      hint: /exceeded the bounded|size limit/i.test(message)
        ? 'The result set is larger than this tool returns in one call. Narrow it with `state`, `year` or a month range, or page with `limit` and `offset`.'
        : /timeout|abort|fetch failed/i.test(message)
          ? 'data.medicaid.gov did not respond in time. Retry once; if it persists, narrow the query.'
          : 'The CMS Medicaid Open Data API refused the request or changed shape. Retry once; if it persists the dataset may have been reissued under a new id.',
    };
  }
}

async function drugUtilization(args: Record<string, unknown>) {
  const ndc = ndcArg(args.ndc), year = drugYear(args.year);
  const conditions: Condition[] = [eq('ndc', ndc)];
  const state = optionalState(args.state);
  if (state) conditions.push(eq('state', state));
  const type = utilizationType(args.utilization_type);
  if (type) conditions.push(eq('utilization_type', type));
  const payload = await query(DATASETS.drug[year], conditions, intArg(args.limit, 100, 1, 500), intArg(args.offset, 0, 0, 100_000));
  return {
    total: payload.count, returned: payload.results.length, records: payload.results.map(projectDrug),
    ndc, year, state: state ?? null, source: drugSource(), interpretation: drugInterpretation(),
  };
}

async function drugStateMarket(args: Record<string, unknown>) {
  const ndc = ndcArg(args.ndc), year = drugYear(args.year);
  const payload = await query(DATASETS.drug[year], [eq('ndc', ndc)], 500);
  if (payload.count > 500) throw new Error('NDC query exceeded the bounded 500-row state-market limit');
  const grouped = groupDrug(payload.results, 'state');
  return {
    total: grouped.length, returned: grouped.length, states: grouped, ndc, year,
    source: drugSource(), interpretation: drugInterpretation(),
  };
}

async function drugTrend(args: Record<string, unknown>) {
  const ndc = ndcArg(args.ndc), state = optionalState(args.state);
  const [from, to] = yearRange(args, 2020, 2026, 7);
  const years = await Promise.all(Array.from({ length: to - from + 1 }, (_, index) => from + index).map(async (year) => {
    const conditions = [eq('ndc', ndc)];
    if (state) conditions.push(eq('state', state));
    const payload = await query(DATASETS.drug[year], conditions, 500);
    if (payload.count > 500) throw new Error(`NDC query for ${year} exceeded the bounded 500-row limit`);
    return { year, ...aggregateDrug(payload.results), suppressed_rows: payload.results.filter(isSuppressed).length };
  }));
  return { ndc, state: state ?? null, years, source: drugSource(), interpretation: drugInterpretation() };
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
  if (payload.count > 500) throw new Error('Monthly managed-care query exceeded the bounded 500-row limit');
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
  if (payload.count > 500) throw new Error('Enrollment operations query exceeded the bounded 500-row limit');
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
interface Condition { property: string; value: string; operator: '=' }
interface QueryResult { count: number; results: Row[] }
const eq = (property: string, value: string): Condition => ({ property, value, operator: '=' });

async function query(dataset: string, conditions: Condition[], limit: number, offset = 0): Promise<QueryResult> {
  const url = new URL(`${BASE}/${dataset}/0`);
  url.searchParams.set('limit', String(limit));
  if (offset) url.searchParams.set('offset', String(offset));
  conditions.forEach((condition, index) => {
    url.searchParams.set(`conditions[${index}][property]`, condition.property);
    url.searchParams.set(`conditions[${index}][value]`, condition.value);
    url.searchParams.set(`conditions[${index}][operator]`, condition.operator);
  });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
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
  if (from > to) throw new Error('from_month must not be after to_month');
  return rows.filter((row) => String(row.month ?? '') >= from && String(row.month ?? '') <= to)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

function yearRange(args: Record<string, unknown>, min: number, max: number, maxSpan: number): [number, number] {
  const from = args.from_year == null ? min : Number(args.from_year);
  const to = args.to_year == null ? max : Number(args.to_year);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to || to - from + 1 > maxSpan) {
    throw new Error(`year range must be ascending within ${min}-${max} and span at most ${maxSpan} years`);
  }
  return [from, to];
}

function drugYear(value: unknown) {
  const year = value == null ? 2025 : Number(value);
  if (!Number.isInteger(year) || !DATASETS.drug[year]) throw new Error('year must be from 2020 through 2026');
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
  throw new Error('utilization_type must be FFS or Managed Care');
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
  if (!/^\d{6}$/.test(month) || Number(month.slice(4)) < 1 || Number(month.slice(4)) > 12) throw new Error('month must use YYYYMM');
  return month;
}
function integerString(value: unknown, key: string) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${key} must be an integer`);
  return String(number);
}
function numberValue(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function stringArg(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function requiredString(args: Record<string, unknown>, key: string) {
  const value = stringArg(args[key]); if (!value) throw new Error(`${key} is required`); return value;
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
