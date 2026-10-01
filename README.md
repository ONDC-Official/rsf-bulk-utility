# ONDC RSF Mock Workbench

MongoDB-backed workbench for testing `receiver_recon` and `on_receiver_recon` with a mock NP. The first screen scopes the workspace by external subscriber URL. Inbound `on_confirm` messages populate saved orders and routing context; sending is operator initiated.

## Run

Copy `.env.example` to `.env` if you do not already have a local `.env`. Run only MongoDB in Docker, then run the API and frontend directly:

```sh
docker compose up -d mongo
npm run api
npm run dev
```

Open <http://localhost:5173>. The API runs on <http://localhost:3000>. MongoDB's container port is published to localhost on port `27018`; the local API uses that address from `.env`. Vite proxies API and mock receiver requests to `localhost:3000`. The demo subscriber URL is `http://localhost:3000/mock-np`.

With demo data enabled, the collector worklist has three unsent orders. Send on_receiver_recon opens custom-order entry directly; received-reconciliation transaction lookup is hidden from the UI.

## Workflow

- `receiver_recon`: select unsent orders for the subscriber, enter one status and one or more settlement amounts per order, preview grouped NTS requests, then send. A successful downstream HTTP 200 locks only the orders in that request. A failed request retains its payload and can be retried with the same IDs.
- `on_receiver_recon`: open custom-order entry directly. Custom-only reviews use the subscriber's latest saved routing context; at least one previous on_confirm or receiver_recon from that NP is required to establish its identity and routing. The call gets new transaction and message IDs. Enter each order's amounts, difference, and assessment, preview, and submit. Difference is never calculated; status-to-amount comparisons are not enforced in either flow. Basic numeric parsing, unique IDs, routing, and draft concurrency safeguards remain. There is no Review summary section. The screen waits for the downstream result and keeps the review on failure.

## API

New custom reviews remain browser-local until Preview or Submit. Unfinished reviews excludes zero-order records. Reviews can be deleted from the list or open workspace without a confirmation or status restriction; existing network-message history is retained.

Custom on_receiver_recon rows use only Order ID, entered Difference amount, and Assessment. Expected and Mock received are neither collected nor required; stored historical amounts remain untouched. Add custom order takes Order ID and Difference amount, with Assessment editable after adding.

| Endpoint | Purpose |
| --- | --- |
| `DELETE /api/cases/:id?subscriber_url=...` | Delete a subscriber-scoped review regardless of status. |
| `POST /api/inbound/on_confirm` | Store TRV order and routing context; no automatic send. |
| `POST /api/inbound/receiver_recon` | Store NTS reconciliation and create a review case. |
| `GET /api/subscriber/orders` | Subscriber-scoped collector worklist with search, filter, and cursor. |
| `POST /api/receiver-recon/preview` | Validate selected orders and amount arrays; persist exact grouped previews. |
| `POST /api/receiver-recon/send` | Claim and send the previewed groups; return each downstream result. |
| `GET /api/receiver-recon/sent` | Inspect the payload and response for a sent order. |
| `GET /api/subscriber/reconciliations` | Find received reconciliation cycles by subscriber and transaction ID. |
| `GET /api/subscriber/known-orders` | Search/page saved receiver-side orders for unsolicited review. |
| `GET /api/subscriber/unsolicited-cases` | Reopen subscriber-scoped unsolicited drafts and failed sends. |
| `POST /api/cases/unsolicited` | Create unsolicited review cases from selected saved orders. |
| `GET /api/cases/:id` | Load a review case. |
| `PUT /api/cases/:id/draft` | Save decisions with version checking. |
| `POST /api/cases/:id/preview` | Preview `on_receiver_recon`. |
| `POST /api/cases/:id/submit` | Send to the subscriber and record the downstream result. |

`ONDC_SUBSCRIBER_ID` is our single participant identity for signing and role detection. If it matches an inbound context's `bap_id`, we are BAP and the other NP is BPP; if it matches `bpp_id`, we are BPP and the other NP is BAP. Reject contexts where neither or both sides match. Route to the opposite side's URI. `OWN_BAP_URI` and `OWN_BPP_URI` are only callback URLs used to populate demo payloads; they do not determine identity.

The mock receiver is `/mock-np/:action`. ONDC Authorization signing and inbound signature verification use `ondc-crypto-sdk-nodejs`. `ONDC_AUTH_MODE` accepts `disabled`, `optional` (sign when configured; accept unsigned inbound requests), or `required` (sign outbound and reject unsigned/untrusted inbound requests). Local runs load credentials from the git-ignored `.env`; Compose passes these settings through its environment. Set `ONDC_UNIQUE_KEY_ID` and `ONDC_SIGNING_PRIVATE_KEY` using the key registered for `ONDC_SUBSCRIBER_ID`. Set `ONDC_SIGNING_PUBLIC_KEY` for verifying requests signed by this same key. Other participants' public keys can be provided as JSON in `ONDC_TRUSTED_PUBLIC_KEYS_JSON`, keyed by `subscriber_id|unique_key_id`, or resolved with `ONDC_REGISTRY_LOOKUP_URL`. Keys are Base64-encoded; keep the private key secret and out of source control. Real-network testing requires credentials registered with ONDC and the destination NP's actual endpoint.

The provisional overpaid response code and the proposed `UNDERPAID`/`OVERPAID` settlement-status values require confirmation against the target NTS schema before contract-conformance claims.

Run focused tests with `npm test`.
