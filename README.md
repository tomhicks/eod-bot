## eod-bot

Uses your git and linear contributions to generate a daily summary of your work.

You'll probably need to hack a few magic strings that I use to split my PRs up and stuff like
that but the general idea should be usable by anyone who has to write daily summaries.

## Setup

1. `cp .env.example .env`
2. Fill in the `.env` file with your details
3. `npm install`
4. `npm run gen-today` to generate today's summary or `npm run gen-yesterday` for yesterday's
