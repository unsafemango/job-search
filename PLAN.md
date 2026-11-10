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
- [x] CLI: `init`, `discover`, `list`, `show`, `mark`, `stats`
- [ ] More sources: public GitHub job lists, Workday posting data, CSV import
- [ ] Cross-source duplicate detection (same company, title and place)
- [ ] Follow-up reminders (applied N days ago, no reply)

### Phase 2: model-rated fit

- [ ] A small model interface (`decide(state, questions)` returning typed
      answers), with one provider behind it
- [ ] Rate each surviving job against the profile: stack match, level match,
      hard requirements the profile does not meet
- [ ] Cache ratings by posting hash so an unchanged posting is not rated twice
- [ ] Spend cap per run, and a cost report

### Phase 3: prepare

- [ ] Tailored one-page resume per job, rendered to PDF
- [ ] Every number and proper noun in a draft checked against the profile in
      code; unsupported claims are refused
- [ ] Draft answers for open questions, with an answer memory
- [ ] Referral finder: match the company against a LinkedIn connections
      export and draft a short message

### Phase 4: dashboard and approval

- [ ] Local web dashboard: today's shortlist, packets to review, needs-you list
- [ ] Approve, edit or dismiss each packet

### Phase 5: send

- [ ] Playwright form filler, one board at a time (Greenhouse first)
- [ ] Read every value back from the page before submitting
- [ ] A submission is "unknown" until a confirmation page is seen; never sent twice
- [ ] Sign-ins, human checks and signatures are handed to you
- [ ] Weekly canary: fill a known form on each board without sending

### Phase 6: learn

- [ ] Read-only Gmail status detection (optional)
- [ ] Re-weight scoring from recorded outcomes once there are enough

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
