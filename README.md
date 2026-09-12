# Pop's Pool

Live standings for the family college football pool. Static site, refreshed by a
scheduled job on Saturdays.

## How it works

`scripts/refresh.mjs` pulls schedules, results, betting lines and SP+ ratings from
CollegeFootballData, simulates the rest of the season 60,000 times, scores every
entry under Pop's rules, and writes `public/data/standings.json`. The page reads
that file. No server, no database.

Scoring, in order:
1. Closest to your own team's regular-season win total (12 games).
2. Smallest total margin error across Georgia–Auburn, Georgia–Ole Miss, and the Iron Bowl.
   Margins are signed, so picking the wrong winner is punished automatically.
3. Correct SEC champion.

## Adding a late entry

Edit `data/entries.json` and push. The next refresh picks it up, or run
`npm run refresh` locally to update immediately.

Margin convention — all signed:
- `ugaAub`   Georgia points minus Auburn points
- `ugaOle`   Georgia points minus Ole Miss points
- `ironBowl` Alabama points minus Auburn points

So "Georgia 31, Auburn 17" is `ugaAub: 14`. "Ole Miss 28, Georgia 24" is `ugaOle: -4`.

## Deploy

1. Create the repo on the flukerdev GitHub account and push this folder.
2. In the repo: Settings → Secrets and variables → Actions → New repository secret.
   Name `CFBD_KEY`, value is your CollegeFootballData key.
3. In the repo: Settings → Actions → General → Workflow permissions → **Read and write**.
   (Without this the bot cannot commit updated standings.)
4. On flukerdev Vercel: New Project → import the repo. Framework preset **Other**,
   output directory `public`. Deploy.
5. Add the domain in Vercel → Settings → Domains.

## Refresh schedule

GitHub Actions runs at 5pm ET and 8pm ET Saturday, 1am ET Sunday, plus a 10am
Sunday safety net. Both EDT and EST crons are listed, so one fires in each half of
the season and the duplicate is a harmless no-op commit.

To refresh by hand: Actions tab → Refresh standings → Run workflow.

## Checking the math

`node tools/verify.mjs` prints the full decomposition per entry — how often each
entry survives the record round, how many rivals it faces, how often it wins from
there — and asserts the win percentages sum to 100. Run it with a couple of
different `SEED` values to confirm the numbers are stable:

    CFBD_KEY=xxx SEED=777    NS=60000 node tools/verify.mjs
    CFBD_KEY=xxx SEED=424242 NS=60000 node tools/verify.mjs

## Model notes

- Betting lines are used where posted; SP+ power ratings fill in for games further out.
- Game margin is simulated as normal around expectation, sd 16 points; total sd 9.5.
- Home field advantage 2.4 points.
- The SEC champion is only the fourth tiebreaker, so it is sampled cheaply from SP+
  rather than simulated conference-wide. It is shown on the site for fun.
- Free CFBD tier allows 1,000 calls per month. Each refresh uses about 8.
