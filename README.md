# job-search

A local command-line tool for finding fewer, better-matched jobs and tracking every application from first look to offer.

It reads public job boards for the companies you choose, drops postings that don't fit your profile (and says why), scores the rest from 0 to 100 with readable reasons, and keeps everything in one SQLite file on your machine.

## Why

Most job tools are built for volume. This one is built for attention: a short, ranked list you can actually work through, about 5 to 10 good applications a day.

- **Your data stays yours.** Your target roles, locations, skills and weights live in `data/`, which is git-ignored. Nothing about you is in the code.
- **Every decision has a reason.** A dropped job tells you why. A score lists what it's made of.
- **Nothing is sent without you.** Finding and ranking are automatic. Applying is up to you.

## Features

- Reads postings from **Greenhouse**, **Lever** and **Ashby** public APIs, **Workday** careers sites, and community job lists on **GitHub** (such as SimplifyJobs)
- Imports jobs from a **CSV** file for anything else
- Filters by title, excluded keywords, seniority level, location, remote, excluded companies and posting age
- Scores each match on title (35), skills named in the posting (35), location (20) and recency (10)
- Hides the same job posted twice, on one board or across boards, so it appears once
- Tracks status: `new`, `shortlisted`, `applied`, `replied`, `interview`, `offer`, `rejected`, `dismissed`, with a dated history and notes
- Reminds you to follow up on applications that have gone quiet
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
| `data/companies.json` | The job boards and job lists to read |

Edit both, then find jobs:

```bash
npm run job -- discover
```

## Usage

```bash
npm run job -- discover                      # read the boards, filter and score
npm run job -- import jobs.csv               # add jobs from a CSV file
npm run job -- list                          # best new matches first
npm run job -- list --status applied -n 50   # filter by status
npm run job -- show <id>                     # score breakdown and history
npm run job -- mark <id> applied --note "Referred by Sam"
npm run job -- followups                     # applications due a follow-up
npm run job -- followed-up <id> --note "Emailed the recruiter"
npm run job -- stats                         # where your search stands
```

### Duplicates

Two postings are the same job when the company, title and locations match, ignoring case, punctuation, accents, order and suffixes like "Inc". Only one shows in `list` and `stats`. If you've acted on one of them, that one shows; otherwise it's the one seen first. A job you've acted on is never hidden. `show <id>` lists the other postings of the same job.

### Follow-ups

An application is due a follow-up when it is still `applied` (no reply yet) and `followUpAfterDays` (default 7) have passed since you applied or last followed up. `followups` lists them, longest wait first. Use `--days <n>` to check a different wait.

When you follow up, run `followed-up <id>`. That logs it in the job's history and starts the wait again. When a company replies, `mark <id> replied` takes the job off the list. `stats` also shows how many follow-ups are due.

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
  "maxPostingAgeDays": 45,
  "followUpAfterDays": 7
}
```

Titles earlier in the list count as better matches. Levels are `internship`, `new_grad`, `mid` and `senior`.

### Companies and job lists

Each entry in `data/companies.json` is one board or list to read:

```json
[
  { "source": "greenhouse", "slug": "stripe", "name": "Stripe" },
  { "source": "lever", "slug": "palantir", "name": "Palantir" },
  { "source": "ashby", "slug": "ramp", "name": "Ramp" },
  { "source": "workday", "slug": "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite", "name": "NVIDIA" },
  { "source": "github", "slug": "SimplifyJobs/New-Grad-Positions", "name": "Simplify New Grad list", "level": "new_grad" }
]
```

| Source | What `slug` is | Notes |
| --- | --- | --- |
| `greenhouse`, `lever`, `ashby` | The company's name in the board's URL, e.g. `stripe` for `boards.greenhouse.io/stripe` | |
| `workday` | The careers site URL, as it appears in your browser | Searched for your target titles. Location, exact date and description are fetched only for postings whose title you'd keep, up to 40 per site |
| `github` | `owner/repo` of a list in the [SimplifyJobs](https://github.com/SimplifyJobs) format | Covers many companies. These lists have no descriptions, so the skills part of the score is estimated |

The optional `level` (`internship`, `new_grad`, `mid` or `senior`) is used when a job's title doesn't state one. Set it for lists that are all one level: a new-grad list often titles its jobs just "Software Engineer", which would otherwise count as `mid`.

### Importing a CSV

For boards with no API, put the jobs in a CSV file and run `import`:

```csv
company,title,url,location,remote,posted,level,description
Acme,Software Engineer,https://acme.example/jobs/1,"Toronto, ON",no,2026-11-01,new_grad,"TypeScript, React"
```

Only `company`, `title` and `url` are required, and columns can be in any order. Separate several locations with `;`. Imported jobs are filtered, scored and de-duplicated like any other, and importing the same file twice adds nothing new.

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
  sources/        job boards, GitHub lists, Workday and CSV import
  jobs/           the job shape, filters and scoring
tests/            offline tests
data/             your files (git-ignored; examples are tracked)
```

## Roadmap

See [PLAN.md](PLAN.md) for the full plan. Next up:

- Model-rated fit, tailored resumes and a local review dashboard
- Assisted form filling, where you approve every submission

The tool will never send applications unattended, get around bot detection or CAPTCHAs, or write anything on a form that your profile doesn't support.

## Acknowledgements

Inspired by [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search), with different priorities.
