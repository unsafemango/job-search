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
- Optionally has Claude read each posting and rate how well it fits you, including requirements you don't meet, using your own Claude Code sign-in (no API key needed)
- Hides the same job posted twice, on one board or across boards, so it appears once
- Tracks status: `new`, `shortlisted`, `applied`, `replied`, `interview`, `offer`, `rejected`, `dismissed`, with a dated history and notes
- Fills and sends applications on Greenhouse, Lever and Ashby in a Chrome window you can watch, checking every value before it sends, and never sending without `--submit`
- Reminds you to follow up on applications that have gone quiet
- Shows a summary of your search, including your positive reply rate

## Requirements

- Node.js 24 or later (it uses the built-in `node:sqlite` module)
- For `rate` and `apply`: [Claude Code](https://claude.com/claude-code) signed in with your Claude account (`rate` can use an Anthropic API key instead)
- For `apply`: Google Chrome

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
npm run job -- rate                          # have Claude rate your best unrated jobs
npm run job -- show <id>                     # score breakdown and history
npm run job -- apply <id>                    # fill one job's form and check it; sends nothing
npm run job -- apply --count 5 --submit      # fill and send your 5 best untried jobs
npm run job -- applications [id]             # what happened, field by field
npm run job -- tailor <id>                   # a resume tailored to one job (apply attaches it)
npm run job -- referrals <id> --draft        # people you know there, and a message to send
npm run job -- memory                        # answers apply reuses on later forms
npm run job -- mark <id> applied --note "Referred by Sam"
npm run job -- followups                     # applications due a follow-up
npm run job -- followed-up <id> --note "Emailed the recruiter"
npm run job -- stats                         # where your search stands
```

### Applying

`apply` opens each job's application form in a Chrome window with its own profile (separate from your everyday browser), and for each form:

1. Reads every question on the page: its label, its options, and whether it's required.
2. Asks your local Claude Code what goes in each field, using only your profile: `contact`, `answers`, `background` and `resumePath`.
3. Checks that answer in code before typing anything. Sponsorship and work authorization must match `answers` for the country asked about. A signature is never given. Every choice must be one of the field's real options.
4. Fills the form, attaches your resume, then reads every value back from the page.
5. Without `--submit`, stops there: nothing is sent, and the forms stay open for you to look at. With `--submit`, sends only a form where every value checked out and no required field is empty, then waits for the page to confirm it.

A form is left for you, with the reason, when it needs something the tool must not or cannot do: a sign-in, a CAPTCHA, an emailed code, a signature, a cover letter, or a question your profile doesn't answer. Add the answer to `answers.other` in your profile, and the next run uses it. A job that was sent, or might have been (Submit clicked with no confirmation), is never sent again. Each run respects `apply.maxPerDay` (default 15) and waits `apply.submitGapSeconds` (default 45) between sends. A sent job is marked `applied` in your tracker.

It works on Greenhouse, Lever and Ashby. Workday (used by most banks and large companies) needs an account on each site and is not supported yet; those jobs show their link for you to apply yourself. Ashby saves each field to the employer's server as it's typed, so even a dry run there leaves an unsent draft. Some boards may treat automated browsers with suspicion; the tool does nothing to hide that it's automated.

### Tailored resumes

`tailor <id>` writes a resume for one job from `data/resume.json`, your resume as data (copy `data/resume.example.json` to start). Claude only **chooses**: which bullets to keep for each role and in what order, which project, which skill groups first. It never rewords a bullet. It does rewrite the summary, and code then checks every number and named term in the new summary against your resume. If anything isn't there, your original summary is kept. The result is rendered to PDF through Chrome, at most two pages, in `data/tailored/<id>/`, and `apply` attaches it to that job's form.

### Answer memory and referrals

When a form fills cleanly, `apply` remembers your written answers. A later form asking the same question gets the same answer, word for word. `memory` lists them, and `memory --forget <text>` removes some.

`referrals <id>` lists people at the job's company from your LinkedIn connections export, saved as `data/connections.csv`. It matches by name, by part of a name, or by acronym ("RBC" for Royal Bank of Canada). With `--draft`, Claude writes a short message to each. Nothing is sent.

### Model-rated fit

The baseline score only counts your skills that a posting names. `rate` goes further: Claude reads each of your best unrated jobs alongside your profile and returns a fit from 0 to 100, the level the job is really hiring for, the skills of yours it uses, and any hard requirements you don't meet (such as "5+ years of experience"). That fit replaces the skills part of the score, and `show <id>` lists the details.

By default `rate` runs your local Claude Code in headless mode (`claude -p`), signed in with your Claude account. There is no API key and no per-token bill; each job uses a little of your Claude plan's usage, like a short chat would.

1. Install [Claude Code](https://claude.com/claude-code) so the `claude` command works in your terminal, then run `claude` once and sign in with your Claude account.
2. Add a `background` to your profile: degree and graduation date, experience, work authorization. The model sees this, your skills, target titles, levels and places, but not your name.
3. Run `npm run job -- discover`, then `npm run job -- rate --limit 3` to try it.

Claude Code runs with no tools and an empty working folder, so it can only read the posting and your profile. Any `ANTHROPIC_API_KEY` is kept from it, so it always uses your sign-in rather than billing a key. If you're not signed in, or your plan's usage limit is reached, the run stops and says so.

The `rating` settings in your profile control it:

| Setting | Default | What it does |
| --- | --- | --- |
| `provider` | `claude-code` | `claude-code` uses your Claude sign-in. `api` uses the Anthropic API with `ANTHROPIC_API_KEY` from `.env`, billed per token |
| `command` | `claude` | The Claude Code command, if it isn't on your `PATH` as `claude` |
| `model` | `claude-opus-5-5` | The Claude model. `claude-sonnet-5-5` or `claude-haiku-5-5` use less of your plan (or cost less on the API) |
| `effort` | `low` | How hard the model thinks: `low`, `medium` or `high`. Higher uses more |
| `maxJobsPerRun` | `25` | At most this many jobs per run. `--limit <n>` overrides it |
| `maxSpendPerRunUsd` | `1` | `api` only: a run stops once its estimated cost reaches this. The job in progress finishes, so a run can go slightly over |

A posting is never rated twice while it and your profile stay the same. Change either, and that job is rated again on the next run. With the `api` provider, `rate` prints what each run cost, `stats` shows the total, and if the model declines a posting, the API retries it on another Claude model where the chosen model supports that.

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
npm test              # offline tests: no network, no API calls, no cost
npm run check-types   # TypeScript type check
```

```
src/
  cli.ts          the commands
  discover.ts     fetch, filter, score, store
  rate.ts         model ratings within the run's caps
  db.ts           the SQLite store
  model/          the rating shape, the local Claude Code and API providers, pricing
  apply/          reading, mapping, filling and sending application forms
  profile/        the profile schema (zod)
  sources/        job boards, GitHub lists, Workday and CSV import
  jobs/           the job shape, filters and scoring
tests/            offline tests
data/             your files (git-ignored; examples are tracked)
```

## Roadmap

See [PLAN.md](PLAN.md) for the full plan. Next up:

- Tailored one-page resumes, with every claim checked against your profile
- A local review dashboard
- Assisted form filling, where you approve every submission

The tool will never send applications unattended, get around bot detection or CAPTCHAs, or write anything on a form that your profile doesn't support.

## Acknowledgements

Inspired by [qbeka/jev-job-search](https://github.com/qbeka/jev-job-search), with different priorities.
