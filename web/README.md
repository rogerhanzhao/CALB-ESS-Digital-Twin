# Control plane

The web control plane for the CALB ESS Digital Twin. It authenticates users, validates
inputs, stores durable job records, reports progress, and serves results.

**It performs no numerical work.** PyBaMM and the SOH engine run in the compute plane —
a separate containerised Python service — which is not yet connected. See
`docs/architecture.md` §1 and `docs/deployment-and-capacity.md`.

## Current status

Until a compute worker is connected, every run is served by the demonstrator progress
engine and is stored with `engine = 'demo'`. Demonstrator numbers are derived at request
time, are never persisted, and are surfaced as demonstrator output by both the API and the
interface. They must not be used for commercial warranty decisions.

## Stack

vinext on Cloudflare Workers, D1 via Drizzle, React 19. Node `>=22.13.0`.

```bash
npm install
npm run dev      # local development
npm run build    # verify build output
npm test         # build, then unit tests
npm run lint
```

## Layout

```text
app/api/simulations/       list + create runs
app/api/simulations/[id]/  fetch + cancel one run
app/page.tsx               simulation workspace
lib/runs.ts                request validation and demonstrator-view derivation
db/schema.ts               scenarios / runs / run_artifacts (see docs/data-model.md)
drizzle/                   migrations
```

## Database

Schema and write-ownership rules are specified in `docs/data-model.md`. Read paths never
write; every mutable run field has exactly one writer.

After changing `db/schema.ts`, regenerate migrations with `npm run db:generate`. Rebase onto
the latest default branch first — migration file numbers collide otherwise, and they must
never be renumbered by hand.

The `DB` binding is declared in `.openai/hosting.json` and simulated locally by
`vite.config.ts`.

## Authentication

Signed-in visitors arrive with `oai-authenticated-user-id` and
`oai-authenticated-user-email` request headers, injected at the edge. The user ID is stable
per user per site. API routes reject requests without it.

`app/chatgpt-auth.ts` holds helpers for optional or required ChatGPT sign-in.
`/signin-with-chatgpt`, `/signout-with-chatgpt`, and `/callback` are reserved by the hosting
platform — do not implement app routes for those paths. Sign-in establishes identity only;
it does not prove workspace membership.
