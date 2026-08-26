# @pipeworx/medicaid-intelligence

Medicaid drug utilization, managed-care enrollment and state enrollment operations from the
CMS Medicaid Open Data API. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | What it returns |
|---|---|
| `medicaid_drug_utilization` | Quarterly state utilization rows for one NDC, fee-for-service and managed care kept separate |
| `medicaid_drug_state_market` | One NDC aggregated across states for a year |
| `medicaid_drug_trend` | Annual prescriptions, units and gross reimbursement for one NDC from 2020 |
| `medicaid_managed_care_summary` | Annual state enrollment, and enrollment in any or comprehensive managed care |
| `medicaid_managed_care_program_mix` | State enrollment by program type — comprehensive MCO, PCCM, MLTSS, behavioral health, dental, transportation, PACE |
| `medicaid_plan_market` | Bounded sample of managed-care plan/program rows by state, with the authoritative matching-row count |
| `medicaid_monthly_managed_care` | Monthly Medicaid/CHIP enrollment for one state and participation category |
| `medicaid_enrollment_operations` | Monthly enrollment and application-processing indicators for one state |

## Auth

None. Every endpoint is public CMS infrastructure at `data.medicaid.gov`.

## Reading these numbers correctly

This source is easy to misread, and most of the pack's design is about preventing that. Each
response carries an `interpretation` field stating the caveat that applies to it.

- **Reimbursement is gross, before rebates.** `total_amount_reimbursed` is what state Medicaid
  programs paid pharmacies. It is neither manufacturer revenue nor net price — Medicaid rebates
  are substantial and are not in this data. Treating these figures as a manufacturer's Medicaid
  revenue overstates it, often by a lot.
- **Suppressed is not zero.** CMS suppresses small cells (`DS`, `*`, `--`, or a
  `suppression_used` flag). Those become `null`, never `0`, and a channel that is entirely
  suppressed is reported as unavailable rather than as an absence of utilization. Tests guard
  this specifically.
- **Fee-for-service and managed care are separate measures** and stay separate. Adding them is
  not meaningful for most questions, because a state's mix shifts over time.
- **Managed-care program categories overlap and must not be summed.** A beneficiary can appear
  under comprehensive MCO and MLTSS and behavioral health. `medicaid_managed_care_program_mix`
  says so in its `interpretation`.
- **Enrollment counts are state-reported program enrollment**, not covered lives attributable to
  a particular insurer. They do not map cleanly onto a payer's book of business.
- **A zero in the plan file can be confidentiality suppression**, not an empty plan.
  `medicaid_plan_market` returns a bounded sample plus the authoritative total row count, so a
  short list never implies a small market.

## Argument conventions

The underlying datasets disagree about how a state is written — the drug files use two-letter
codes, the enrollment and managed-care files use full names. **Both forms are accepted on every
tool** and converted internally. This matters: before that, asking the managed-care summary for
`"CA"` matched nothing and returned a confident `total: 0`, which reads as "California has no
managed care" rather than as a wrong argument.

`ndc` takes an exact 11-digit National Drug Code, hyphenated or not. A brand or ingredient name
returns `{found:false, reason:'ndc_expected_got_name'}` with a hint pointing at `openfda_drug_label`
or `rxnorm` to resolve it first.

## Failure shapes

A recoverable caller mistake resolves to `{found:false, reason, hint}` naming what to do instead.
An upstream failure or a genuine defect resolves to `{error, hint}`. The two are deliberately
distinguishable, so a monitoring sweep can tell "CMS refused us" apart from "we returned garbage".

## Data sources

All datasets are queried through the CMS Medicaid Open Data datastore API,
`https://data.medicaid.gov/api/1/datastore/query`:

- [State Drug Utilization Data](https://data.medicaid.gov/dataset?tags=State%20Drug%20Utilization%20Data) — one dataset per year, 2020 through 2026
- [Managed Care Enrollment Summary](https://data.medicaid.gov/dataset/52ed908b-0cb8-5dd2-846d-99d4af12b369) and [enrollment by program](https://data.medicaid.gov/dataset/e2ce0d2f-07c5-5213-947a-31e19bc649f6)
- [Managed Care Plan and Program data](https://data.medicaid.gov/dataset/0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe)
- [Monthly Medicaid and CHIP managed-care enrollment](https://data.medicaid.gov/dataset/89baf100-259b-4763-b9e2-337972f988c4)
- [Medicaid and CHIP enrollment and operations reports](https://data.medicaid.gov/dataset/6165f45b-ca93-5bb5-9d06-db29c692a360)

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "medicaid-intelligence": {
      "url": "https://gateway.pipeworx.io/medicaid-intelligence/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/medicaid-intelligence/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Medicaid Intelligence data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
