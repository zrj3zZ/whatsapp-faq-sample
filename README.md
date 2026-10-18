# WhatsApp FAQ webhook: independently built work sample

This is a small, working Python work sample for fixed-scope SME automation projects. It was built with AI assistance and tested locally. **It is not a past client project, a deployed n8n workflow, or evidence of live Meta account testing.** All business details, IDs and test secrets are synthetic.

## What it demonstrates

- Meta-style GET verification and raw-body HMAC-SHA256 signature validation.
- Approved FAQ responses only; no generated prices or invented answers.
- SQLite transactions prevent duplicate webhook deliveries from creating duplicate outbox rows, including concurrent requests and restarts.
- STOP cancels pending replies and pauses automation; START resumes it.
- Unknown questions and media create a human-handoff record and pause automation. This is a local record, not an integrated agent inbox or a notification to staff.
- An explicit sender adapter records successful responses. Network timeouts/5xx stay `uncertain` for manual reconciliation instead of being blindly retried. This does **not** guarantee exactly-once external delivery.
- Standard library only. No LLM, SaaS subscription, credentials or live messaging needed to run tests.

## Run the evidence

Python 3.10 or later:

```sh
python -m unittest -v
```

The suite includes a real local HTTP server and mocked external sends. See `test-results.txt` for the actual run. Nothing in the test suite contacts Meta or sends a real message.

To run the localhost webhook on PowerShell:

```powershell
$env:WA_APP_SECRET='synthetic-app-secret'
$env:WA_PHONE_ID='DEMO_PHONE'
$env:WA_VERIFY_TOKEN='synthetic-verify'
python faq_bot.py
```

The service binds only to `127.0.0.1`. Incoming events queue replies; serving the webhook does not dispatch them. Do not expose Python's built-in HTTP server directly to the internet.

## Limits and next paid milestone

A real deployment needs the client's verified number, credentials stored outside source, an HTTPS application server/proxy, a bounded worker with rate-limit backoff, handoff notification/inbox integration, log retention and access controls. An n8n HTTP Request node can call an agreed adapter; no n8n workflow import/runtime was tested here. Local SQLite is for a small single-host pilot, not a distributed multi-tenant service.

STOP cannot recall a request already being transmitted. `uncertain` entries need operator reconciliation before any resend. There is no automatic expiry/retention cleanup yet. Multi-message processing is transactional; a malformed/conflicting event rejects the whole batch. Contacts and message text should be treated as private customer data in a real deployment.

Suggested **non-binding** commercial starting point: USD 75 paid pilot for one agreed FAQ flow and synthetic acceptance tests; approximately USD 250 total for a single-number, up-to-30-FAQ first deployment, with the pilot credited. Final scope, availability, mainland-China-compatible payment method and fees must be agreed before engagement. Hosting/Meta charges belong on the client's account. This sample creates no client obligation or promised income.

## Protocol references

- [Meta's official webhook signature example](https://github.com/fbsamples/whatsapp-api-examples/tree/main/signature-validation-with-webhooks-payloads)
- [Meta's official WhatsApp Postman collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api)

The sample is original implementation code, not copied from the referenced examples. Configure the currently supported Graph API version for a live account; no version is assumed by the sender.
