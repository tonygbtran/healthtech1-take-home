# Registration-Form Ingestion Pipeline

An Express + TypeScript service that ingests patient registration forms from an unreliable third-party provider, stores every payload durably, validates and geocodes them, transforms them into the FORM-BOT schema, and guarantees a notification email for every successfully processed form — while ensuring the FORM-BOT never sees the same form twice.

## Quick start

Prerequisites: Node 20+, Docker.

```sh
docker compose up -d --wait   # Postgres 16: app db (5432) and test db (5433)
npm install
npm test                      # integration + unit tests against the test db (migrates it automatically)
npm run dev                   # applies pending migrations, then serves on :3000
```

Other commands:

```sh
npm run migrate     # apply pending migrations without starting the server
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
```

Configuration is via environment variables, all with working defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgres://forms:forms@localhost:5432/forms` | App database |
| `POLL_INTERVAL_MS` | `1000` | Worker tick interval |
| `MAX_ATTEMPTS` | `5` | Geocode retry cap before parking |
| `BACKOFF_BASE_MS` | `1000` | Exponential backoff base (doubles per attempt) |
| `EMAIL_RECIPIENT` | `happyforms@bots.com` | Notification recipient |

Tests use `TEST_DATABASE_URL` (default `postgres://forms:forms@localhost:5433/forms_test`), so they never touch the app database.

## Endpoints

### `POST /ingest`

Accepts a registration form. The contract is deliberately simple for the provider: **400 means "nothing storable" (unparseable JSON or a non-object body); 202 means "we have it"** — even if the payload is invalid, a duplicate, or a correction. The response body states which outcome occurred.

New valid form:

```sh
curl -s -X POST localhost:3000/ingest \
  -H 'Content-Type: application/json' \
  -d @src/forms/examples/person_one.json
# 202 {"outcome":"validated","applicationReference":"GRU-123089-2026"}
```

Invalid form (still stored, parked as `validation_failed` for `/retry` after a fix):

```sh
curl -s -X POST localhost:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{"application_reference":"GRU-999","name":"Jane Doe"}'
# 202 {"outcome":"validation_failed","applicationReference":"GRU-999","errors":[...]}
```

Exact resend (same `application_reference`, same payload) — idempotent no-op:

```sh
curl -s -X POST localhost:3000/ingest \
  -H 'Content-Type: application/json' \
  -d @src/forms/examples/person_one.json
# 202 {"outcome":"duplicate","applicationReference":"GRU-123089-2026"}
```

Correction (same reference, different payload) **before** the form completes — payload replaced, pipeline restarts from `received`:

```sh
curl -s -X POST localhost:3000/ingest \
  -H 'Content-Type: application/json' \
  -d "$(jq '.email = "john.doe+corrected@example.com"' src/forms/examples/person_one.json)"
# 202 {"outcome":"corrected","applicationReference":"GRU-123089-2026"}
```

The same request **after** the form has completed — the correction is discarded (the FORM-BOT must never see the same form twice), but recorded as a `correction_discarded` audit event:

```sh
curl -s -X POST localhost:3000/ingest \
  -H 'Content-Type: application/json' \
  -d "$(jq '.email = "john.doe+too.late@example.com"' src/forms/examples/person_one.json)"
# 202 {"outcome":"correction_discarded","applicationReference":"GRU-123089-2026"}
```

Unparseable or non-object body:

```sh
curl -s -X POST localhost:3000/ingest -H 'Content-Type: application/json' -d '[1,2]'
# 400 {"error":"Request body must be a JSON object"}
```

### `GET /forms/failed`

Lists parked forms with status, attempt count and last error, so on-call can see what is stuck without querying the database:

```sh
curl -s localhost:3000/forms/failed
# 200 {"forms":[{"applicationReference":"GRU-999","status":"validation_failed",
#   "attemptCount":0,"lastError":{"validationErrors":[...]},"updatedAt":"..."}]}
```

### `POST /retry`

Resets `attempt_count`/`next_retry_at` and returns forms to the pipeline — used after shipping a code fix, so the provider never has to resubmit. With no body it retries **all** failed forms; with `applicationReference` it retries one:

```sh
curl -s -X POST localhost:3000/retry
# 200 {"retried":3}

curl -s -X POST localhost:3000/retry \
  -H 'Content-Type: application/json' \
  -d '{"applicationReference":"GRU-999"}'
# 200 {"retried":1}
# 404 if the reference is unknown; 409 if the form is not in a failed state
```

### `GET /health`

```sh
curl -s localhost:3000/health
# 200 {"status":"ok"}  /  503 {"status":"unavailable"} when the database is unreachable
```

## Architecture

```mermaid
flowchart LR
    provider([3rd-party provider]) -->|POST /ingest| ingestion[routes → ingestion service]
    ingestion -->|raw payload, always stored| received

    subgraph status ["forms table — status machine"]
        received --> validated
        validated --> geocoded
        geocoded --> completed["completed (terminal, immutable)"]
        received --> validation_failed
        validated -->|"retried with backoff; parks after MAX_ATTEMPTS"| geocode_failed
        validated --> transform_failed
    end

    validation_failed & geocode_failed & transform_failed -.->|POST /retry| received
    completed -->|same transaction| outbox[(outbox_emails row)]
    outbox -->|"worker drains, retries indefinitely"| email([email provider])
```

- **Layering**: routes → services (ingestion, worker, retry) → repositories (forms, outbox, events) → injected providers (geocoder, email). The pipeline never imports a provider directly; tests substitute deterministic fakes (always-succeed, always-fail, fail-N-then-succeed).
- **Worker**: an in-process poll loop around a single exported `tick()` that (a) advances eligible forms — retryable status, `next_retry_at` passed, attempts under the cap — and (b) drains unsent outbox emails. `tick()` is the test seam; the interval loop is a thin shell around it.
- **Audit trail**: every status transition inserts a `form_events` row in the same transaction, and the table is append-only (enforced by a trigger). "What happened to this form?" is always answerable.
- **Migrations**: forward-only SQL files under `migrations/`, applied by a minimal runner that records applied filenames; run automatically on server start.

## Design decisions & tradeoffs

**202 for almost everything.** `/ingest` returns 202 for anything storable — valid, invalid, duplicate, correction — and 400 only for unparseable/non-object bodies. *Tradeoff*: the provider gets no immediate signal that a payload failed validation (the response body says so, but a fire-and-forget provider won't read it). In exchange, ingestion is decoupled from our internal validation: healthcare data is never lost to a rejection, and provider schema drift parks forms on our side where we can fix and `/retry` them. Payloads even missing an `application_reference` are stored under a synthetic hash-derived reference rather than dropped.

**Payload-aware dedupe and corrections.** Duplicates are detected by `application_reference` + SHA-256 of the canonicalised payload. Identical resend → no-op; different payload before completion → correction, reprocessed from `received`; different payload after completion → discarded with an audit event. *Tradeoff*: an honest post-completion correction is silently (to the provider) dropped — but the never-twice guarantee for the FORM-BOT is the harder requirement, and the audit event preserves evidence the correction arrived so it can be handled manually.

**Transactional outbox for the guaranteed email.** The outbox row is inserted in the same transaction that marks the form `completed`, so a form cannot complete without its notification existing, and vice versa. The sender loop retries indefinitely with capped exponential backoff. *Tradeoff*: at-least-once delivery means a crash between send and `sent_at` can produce a duplicate email — accepted as the safer failure mode versus a lost notification.

**In-process worker, not a queue.** A poll loop in the same process avoids a broker (Redis/SQS/pg-boss) for a take-home-sized system, and the database *is* the queue: status + `next_retry_at` columns make every retry durable and inspectable with SQL. *Tradeoff*: no horizontal scaling — two instances would race on the same forms. The next step is documented below.

**Single-table status machine + append-only audit log.** One `forms` row per application reference carrying status, raw payload, transformed payload, error and retry state — no join needed to answer "where is this form?" — with history pushed into `form_events`. *Tradeoff*: the `forms` row only shows current state, and mutable rows are riskier than event sourcing; the append-only trigger-protected `form_events` table restores the full history without the complexity of rebuilding state from events.

**Transient vs permanent failures are handled differently.** Geocoder 500s are transient: retried automatically with exponential backoff up to `MAX_ATTEMPTS`, then parked as `geocode_failed`. Validation/transform failures are permanent: no retry will fix them, so they park immediately and wait for an engineer to ship a fix and call `/retry`. *Tradeoff*: the classification is baked in; a genuinely transient transform bug still needs a human `/retry`.

## Assumptions

- **Name splitting**: the last whitespace token is `lastName`, everything before it `firstName`; a single token becomes `firstName` with an empty `lastName`. Wrong for e.g. "Ana María de la Cruz" — flagged to the provider; a structured name in the ingest schema is the real fix.
- **Gender mapping**: the ingest schema's `other` maps to the transformed schema's `prefer-not-to-say`. These are not semantically identical; documented assumption pending provider confirmation.
- **Unknown fields** are stripped from the transformed output and logged, never rejected — the raw payload retains everything, so nothing is lost when the provider adds fields unannounced.
- Emails from the same mock provider contract as geocoding: a `statusCode` response, with 200 meaning success.

## Known limitations

- **Single worker instance**: eligible-form selection has no cross-process locking; running multiple instances could process the same form concurrently (the completion `UPDATE` is guarded by payload hash, so the never-twice invariant still holds, but work would be wasted).
- **No authentication** on any endpoint, including the operational `/retry`.
- **Duplicate emails possible** (at-least-once outbox delivery, by design).
- **No pagination** on `GET /forms/failed` — fine at take-home scale.
- **The app itself is not containerised**; only Postgres runs in Docker.

## What I'd do next

1. **CI** — GitHub Actions running typecheck + tests against a Postgres service container.
2. **Auth** — at minimum a shared-secret header on `/ingest` and `/retry`.
3. **Metrics** — counters for ingest outcomes, parked forms, outbox lag; alerting on parked-form age.
4. **App Dockerfile** — multi-stage build so `docker compose up` runs everything.
5. **Real queue / multi-instance workers** — either a proper job queue, or keep Postgres and claim forms with `SELECT … FOR UPDATE SKIP LOCKED` so multiple workers can run safely.

---

<details>

At Healthtech-1, one of our core responsibilities is to ingest registration forms, transform them, update some external systems and get them ready for future processing (by the FORM-BOT).
We are sent these forms by a particularly unreliable 3rd party - we should expect them to make schema changes without informing us, send duplicate forms, or generally just be badly behaved!
As this is important healthcare data, we need to design our systems to be resilient to these kinds of errors.

Your task is to code a system for ingesting and processing these forms. For a form to become ready for our bots, it will need to:
- Be ingested into a database (via an `/ingest` endpoint). 
- Conform to the schema we've currently agreed with the external provider. This schema is found in `ingested_schema.ts` (but unfortunately the data source isn't 100% reliable and schema changes aren't always communicated in a timely fashion!)
- Have a longitude and latitude so that we have specific address information for the FORM-BOT. A mock implementation of a geocoding API (to transform the postcode into lat/long) is provided.
- Be transformed into the schema found in `transformed_schema.ts`.

In addition to this, if the transformation/another step is unsuccessful, we'd ideally like to be able to capture the error/data, ship a code change and then handle this form once that change has been deployed (e.g some kind of `/retry` endpoint)

Some additional notes on the system
- The third party external provider does not guarantee exactly once delivery
- We should never give the FORM-BOT the same form twice
- If the transform is successful, we should send a guaranteed email to our team happyforms@bots.com that a form was ingested

Some notes on this take home
- We expect you to add some basic tests to your code
- We expect you to use an actual database, as we'd like to see your schema design
- You can use AI to aid you in this task but please do not just ask Claude to do the whole thing for you
- You are free to pick another server technology (e.g. NestJS) if you wish and even pick another language though please check with us first on language.

How to submit
- The email sent to you has a unique submission link, which will take you to a submission portal
- Please submit on the portal: a link to your repository and a link to a 5 minute (max) loom which explains your code and some of your design decisions
- If possible, please submit within 4-5 days of receiving the task

</details>
