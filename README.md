# Heartstrings Studio — Story Intake

A calm, conversational intake for clients commissioning a custom song. It feels
like a thoughtful interview rather than a form, and produces a structured brief
that's emailed to the studio.

Two pieces:

- **`index.html`** — the entire client-facing page (HTML/CSS/JS, no build step).
  Deploys to GitHub Pages.
- **`worker/worker.js`** — a Cloudflare Worker that holds the Anthropic API key
  as a secret and proxies the intake's follow-up questions. The browser never
  touches the key.

The page submits the finished brief to Formspree
(`https://formspree.io/f/xykbvdrb`).

---

## 1. Deploy the Worker

You'll need the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/)
CLI and a free Cloudflare account.

```bash
cd worker
npx wrangler login          # one-time browser auth
npx wrangler deploy         # publishes the Worker; prints its URL
```

Then store your Anthropic API key as a secret (it is never committed):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# paste your key when prompted
```

Copy the deployed URL that `wrangler deploy` printed — it looks like
`https://heartstrings-intake.YOUR-SUBDOMAIN.workers.dev`.

**Lock the proxy to your page (important).** Left open, the Worker will proxy
the Anthropic API for *anyone* who finds its URL — on your key, your bill. Set
`ALLOWED_ORIGIN` in `worker/wrangler.toml` to your published page's origin
(e.g. `https://heartstringsstudio.github.io`, comma-separate several, no
trailing slash) and run `npx wrangler deploy` again. The Worker enforces this
server-side, so it stops scripted callers, not just browsers. It also caps
payload size by default.

**Optional — rate limiting.** To throttle abusive traffic per IP, create a KV
namespace and bind it as `RATE_LIMIT` (see `worker/wrangler.toml`):

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Paste the printed id into `wrangler.toml`, uncomment the `[[kv_namespaces]]`
block, and redeploy. Without the binding, rate limiting is simply skipped.

## 2. Point the page at the Worker

Open `index.html` and edit the one config line near the bottom:

```js
const WORKER_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
```

Paste the URL from step 1.

## 3. Publish the page on GitHub Pages

1. Push this repo to GitHub.
2. In the repo: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick your branch and the `/ (root)` folder, then **Save**.
5. After a minute, your intake is live at
   `https://yourusername.github.io/REPO-NAME/`.

That's it. Submissions arrive in the Formspree inbox for the form above; the
first submission will ask you to confirm the destination email once.

---

## How it flows

1. **Route** — who the song is for, who it's from, and the occasion.
2. **Open door** — one warm prompt and a big, unhurried text box.
3. **The dig** — tailored follow-ups (via the Worker) that draw out a sensory
   detail, a real phrase, one small moment, and the emotional core. Up to two
   rounds; if the Worker is unreachable it quietly skips ahead.
4. **Essentials** — name spellings, pronouns, must-include / must-avoid, feel,
   date, contact, and delivery preference.
5. **Confirm & send** — a clean read-only summary, then off to the studio.

### The memorial path

When the occasion is **Memorial**, the experience softens: cooler palette, more
white space, slower pacing, an early reassurance that there are no wrong answers,
and far fewer questions (capped at two, a single round). The follow-ups only ever
ask about who the person was — never how or why they died — and every one makes
clear it's okay to skip.

## Notes

- The intelligence is invisible by design. Nothing in the client-facing copy
  references how the questions are generated.
- The Worker passes through only the `messages` payload; it owns the model,
  token limit, and the interviewer instructions.
