# job-search

A local command-line tool for finding fewer, better-matched jobs and tracking every application from first look to offer.

It reads public job boards for the companies you choose, drops postings that don't fit your profile (and says why), scores the rest from 0 to 100 with readable reasons, and keeps everything in one SQLite file on your machine.

## Why

Most job tools are built for volume. This one is built for attention: a short, ranked list you can actually work through, about 5 to 10 good applications a day.

- **Your data stays yours.** Your target roles, locations, skills and weights live in `data/`, which is git-ignored. Nothing about you is in the code.
- **Every decision has a reason.** A dropped job tells you why. A score lists what it's made of.
- **Nothing is sent without you.** Finding and ranking are automatic. Applying is up to you.

## Features

- Reads postings from **Greenhouse**, **Lever** and **Ashby** public APIs
- Filters by title, excluded keywords, seniority level, location, remote, excluded companies and posting age
- Scores each match on title (35), skills named in the posting (35), location (20) and recency (10)
- Tracks status: `new`, `shortlisted`, `applied`, `replied`, `interview`, `offer`, `rejected`, `dismissed`, with a dated history and notes
- Shows a summary of your search, including your positive reply rate

## Requirements

- Node.js 24 or later (it uses the built-in `node:sqlite` module)

## Getting started

```bash
git clone https://github.com/unsafemango/job-search.git
cd job-search
npm install
npm run job -- init
```

`init` creates two files from the examples:

| File | What it holds |
| --- | --- |
| `data/profile.json` | The roles, levels, locations, skills and companies you want, and the ones you don't |
| `data/companies.json` | The company job boards to read |

Edit both, then find jobs:

```bash
npm run job -- discover
```

## Usage

```bash
npm run job -- discover                      # read the boards, filter and score
npm run job -- list                          # best new matches first
npm run job -- list --status applied -n 50   # filter by status
npm run job -- show <id>                     # score breakdown and history
npm run job -- mark <id> applied --note "Referred by Sam"
npm run job -- stats                         # where your search stands
```

### Profile

```json
{
  "name": "Ada Lovelace",
  "target": {
    "titles": ["software engineer", "backend", "full stack"],
    "excludeKeywords": ["hardware", "sales", "manager"],
    "levels": ["internship", "new_grad"]
  },
  "locations": {
    "include": [
      { "match": "Toronto", "weight": 1 },
      { "match": "Canada", "weight": 0.8 }
    ],
    "exclude": [],
    "remote": true,
    "remoteWeight": 0.9
  },
  "skills": ["TypeScript", "Python", "React", "PostgreSQL"],
  "excludeCompanies": [],
  "maxPostingAgeDays": 45
}
```

Titles earlier in the list count as better matches. Levels are `internship`, `new_grad`, `mid` and `senior`.

### Companies

Each entry is a board and the company's name in that board's URL:

```json
[
  { "source": "greenhouse", "slug": "stripe", "name": "Stripe" },
  { "source": "lever", "slug": "palantir", "name": "Palantir" },
  { "source": "ashby", "slug": "ramp", "name": "Ramp" }
]
```

For example, `boards.greenhouse.io/stripe` has the slug `stripe`.

To keep a second profile or data set, point `JOB_SEARCH_DATA` at another folder.

## Development

```bash
npm test              # offline tests, no network
npm run check-types   # TypeScript type check
```

```
src/
  cli.ts          the commands
  discover.ts     fetch, filter, score, store
  db.ts           the SQLite store
  profile/        the profile schema (zod)
  sources/        job board parsers
  jobs/           the job shape, filters and scoring
tests/            offline tests
data/             your files (git-ignored; examples are tracked)
```

## Roadmap

See [PLAN.md](PLAN.md) for the full plan. Next up:

- More sources (GitHub job lists, Workday, CSV import) and cross-source duplicate detection
- Follow-up reminders for applications with no reply
- Model-rated fit, tailored resumes and a local review dashboard
- Assisted form filling, where you approve every submission

The tool will never send applications unattended, get around bot detection or CAPTCHAs, or write anything on a form that your profile doesn't support.

## Acknowledgements

Inspired by [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search), with different priorities.
