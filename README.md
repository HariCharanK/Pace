# Pace — reading speed trainer

A local web app for measuring and training reading speed on your own reading material, with a comprehension quiz after every session.

```bash
git clone git@github.com:HariCharanK/Pace.git && cd Pace
uv run python ingest.py                # first run: fetch the corpus (~1-2 min)
uv run uvicorn app:app --port 8765     # then open http://localhost:8765
```

API keys are read from `~/keystore/credentials.env`, or from a local `.env` (see `.env.example`).

### Running it in the background (macOS)

Running uvicorn from a terminal or an editor ties the server to that process; when it's closed the app shows "The Pace server isn't running". To keep it up permanently, install the LaunchAgent. It starts at login and restarts the server if it dies:

```bash
./scripts/install-launchagent.sh          # installs ~/Library/LaunchAgents/com.haricharank.pace.plist and starts it
launchctl kickstart -k gui/$(id -u)/com.haricharank.pace   # restart (e.g. after editing app.py or changing keys)
tail -f ~/Library/Logs/pace.log           # logs
```

## How it works

- **Speed test**: read the passage naturally. The timer pauses if you switch tabs. Then answer 5 questions from memory: 1 main idea, 3 details, 1 inference.
- **Pacer drill**: a highlight band sweeps line by line at your target wpm. `Space` pauses, `↑`/`↓` changes speed.
- **Flash (RSVP)**: words appear one at a time (or 2–3 at a time) in a fixed spot, with the focus letter marked. This stops you from re-reading. `←`/`→` jumps by sentence.
- **Effective speed** = wpm × comprehension. This is the number to grow.
- **Today's session** on the Progress page builds a 3-step plan from your history:
  1. Pacer warm-up at your target pace. The target is your recent pace +10% if your last comprehension was ≥ 80%, the same if it was 60–80%, and −8% below that.
  2. An overspeed RSVP sprint at about 145% of your pace.
  3. A free-reading test to see whether your normal pace moved.

## Corpus

Everything is configured in `sources.json`:

| Type | What's there now |
|---|---|
| News feeds | NYT Health / Well / Tech / Science / Money / Business / World (fetched with a Googlebot user agent, which gets the full text; personal use only), The Conversation |
| Blogs | Morgan Housel (Collab Fund), Farnam Street, James Clear, Cal Newport, Noahpinion, Experimental History, Wait But Why, Atlas Obscura |
| Essays | Paul Graham classics, Steve Jobs' 2005 Stanford speech, Housel's *Psychology of Money* |
| Knowledge bytes | 35 Wikipedia topics: Jobs/Musk/Rockefeller/Watt/Brunel/Arkwright, Industrial Revolution, cholera and penicillin history, tardigrades and octopus intelligence, tulip mania, LTCM, Weimar hyperinflation, the Cuban Missile Crisis, Pomodoro… |
| Book excerpts | Franklin's *Autobiography*, Bennett's *How to Live on 24 Hours a Day*, Smiles' *Self-Help*, Darwin's *Beagle*, Carnegie, Ford's *My Life and Work*, Nightingale, Booker T. Washington (public domain, from Project Gutenberg) |

Passages are trimmed to about 450–2,300 words. Very dense prose (Flesch reading ease below 25) is skipped. The **Sources** page in the app lets you:
- add any article by URL, or paste text (useful for long X/Twitter posts and newsletters)
- add RSS feeds; there are one-click suggestions such as Aeon, Psyche, Knowable, Nautilus, Construction Physics, The Marginalian, Of Dollars and Data, and Ness Labs
- turn feeds on and off, and **Fetch new articles** to pull in the latest

You can also refresh from the command line: `uv run python ingest.py` (or `ingest.py feeds`).

## Quizzes

- Quizzes for the starter library are already written and stored in `data/quizzes/<passage_id>.json`. You can drop in or edit files there; changed files are re-imported when the server starts.
- For new content the app reads `ANTHROPIC_API_KEY` (Claude, default model `claude-opus-5-5`) or `OPENAI_API_KEY` (default model `gpt-5-mini`) from `~/keystore/credentials.env`. Values in `speedreader/.env` take priority. Quizzes are generated on first open and in the background after each fetch. Restart the server after changing keys. Optional settings: `QUIZ_MODEL=…` to change the model, and `QUIZ_PROVIDER=anthropic|openai` to choose when both keys are set.
- Without a key, new passages can still be used for speed-only sessions.

Data (passages, quizzes and results) is stored in `data/speedreader.db` (SQLite) and is not committed; only `data/quizzes/` is.
