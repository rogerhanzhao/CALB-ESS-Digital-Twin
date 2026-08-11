/**
 * Runtime bindings this worker expects.
 *
 * The project does not use `wrangler.jsonc`, so `wrangler types` cannot generate
 * these. Bindings are declared in `.openai/hosting.json` and simulated locally by
 * `vite.config.ts`; this file is the type-level counterpart and must be kept in step
 * with both. `Cloudflare.Env` is declared empty by `@cloudflare/workers-types` and is
 * intended to be extended per project — TypeScript merges the declarations.
 */
declare namespace Cloudflare {
  interface Env {
    /** Static assets, served by the hosting platform. */
    ASSETS: Fetcher;
    /** D1 database holding scenarios, runs, and run artifacts. See docs/data-model.md. */
    DB: D1Database;
    /** Private standard-study requests and immutable result bundles. */
    STUDY_ARTIFACTS: R2Bucket;
    /** Server-only bearer token used by Python compute workers. */
    WORKER_API_TOKEN: string;
  }
}
