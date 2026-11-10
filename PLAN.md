# Build plan

A local job-search tool: find fewer, better-matched jobs, prepare each
application properly, send only what you approve, and learn from what gets
replies. Inspired by [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search),
with different priorities.

## Principles

1. **Everything about you is in `data/`, never in code.** Roles, levels,
   locations and weights come from `data/profile.json`.
2. **Quality over volume.** The limit is your attention: 5 to 10 good
   applications a day.
3. **Nothing is sent without your yes.** Finding and preparing are automatic;
   sending is not.
4. **Every decision has a reason you can read.** A dropped job says why; a
   score lists what it is made of.
5. **Outcomes drive ranking.** Replies and interviews are recorded and used.

## Phases

### Phase 1: find and track (this scaffold)

Useful with no browser automation and no model.

- [x] Profile schema, validated (`src/profile/schema.ts`)
- [x] One SQLite file for all state (`src/db.ts`)
- [x] Sources: Greenhouse, Lever, Ashby public APIs (`src/sources/`)
- [x] Filters driven by the profile, each with a reason (`src/jobs/filters.ts`)
- [x] Baseline score with reasons, no model (`src/jobs/score.ts`)
- [x] CLI: `init`, `discover`, `list`, `show`, `import`, `mark`, `followups`, `followed-up`, `stats`
- [x] More sources: public GitHub job lists (SimplifyJobs format), Workday, CSV import
- [x] Cross-source duplicate detection (same company, title and place)
- [x] Follow-up reminders (applied N days ago, no reply): `followups`, `followed-up`

### Phase 2: model-rated fit

- [x] A small model interface (`Rater` in `src/model/rating.ts`) returning a
      typed, schema-checked rating, with two providers: local Claude Code on
      your Claude plan (`src/model/claude-code.ts`, the default) and the
      Anthropic API (`src/model/claude.ts`)
- [x] Rate each surviving job against the profile: stack match, level match,
      hard requirements the profile does not meet (`rate`)
- [x] Cache ratings by posting hash so an unchanged posting is not rated twice
- [x] Spend cap per run, and a cost report (`rate`, `stats`)

### Phase 3: prepare

- [x] Tailored resume per job, rendered to PDF (`tailor`)
- [x] Every number and proper noun in a draft checked against the profile in
      code; unsupported claims are refused
- [x] Draft answers for open questions, with an answer memory (`memory`)
- [x] Referral finder: match the company against a LinkedIn connections
      export and draft a short message

### Phase 4: dashboard and approval

- [x] Local web dashboard: today's shortlist, packets to review, needs-you list (`dashboard`)
- [x] Approve or dismiss each job; approved jobs are applied to first

### Phase 5: send

- [x] Playwright form filler for Greenhouse, Lever and Ashby (`src/apply/`),
      with Claude Code mapping fields from the profile and code checking
      sponsorship, authorization, signatures and options
- [x] Read every value back from the page before submitting
- [x] A submission is "unconfirmed" until a confirmation page is seen; never sent twice
- [x] Sign-ins, human checks and signatures are handed to you
- [x] Daily automatic applying from a job-finder's list (`daily`, `/daily`), using the PDFs it wrote
- [ ] Workday: accounts and forms with several pages
- [ ] Weekly canary: fill a known form on each board without sending

### Phase 6: learn

- [x] Read-only reply detection: `inbox` rules in code, fed by the `/inbox` Claude Code skill through your connected mail
- [x] Re-weight scoring from recorded outcomes once there are enough (`learn`)

## Deliberately not built

- Unattended sending, or anything designed to avoid a board's bot detection
- Solving CAPTCHAs, creating accounts, signing agreements
- Writing anything on a form that the profile does not support

## Layout

```
data/                 yours, git-ignored (examples are tracked)
  profile.json        who you are and what you want
  companies.json      which company boards to read
  jobs.db             every job seen, its score, its status, its history
src/
  cli.ts              the commands
  discover.ts         fetch, filter, score, store
  db.ts               the SQLite store
  profile/            the profile schema
  sources/            one file per job board
  jobs/               the job shape, filters, scoring
tests/                offline, no network
```
