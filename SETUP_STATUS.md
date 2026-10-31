# Setup status

Progress on the one-time setup in CLAUDE.md section 3. Tick items only when verified.

Last updated: 2026-10-27 (UTC)

## Repository

- [x] pnpm workspace (`apps/*`, `packages/*`) per CLAUDE.md section 6, pnpm pinned to 10.12.4 via `packageManager`
- [x] `.env.example` lists every key from section 4 (empty values)
- [x] `.env` and `*.local.md` are gitignored

## 3.1 PayPal Developer (sandbox)

- [x] Developer account and sandbox enabled
- [x] Sandbox accounts created (see table below)
- [x] REST app created and linked to the **US business** account; Client ID and Secret in `.env`
      (verified 2026-10-27 with `pnpm gate:paypal --auth-check`: orders pay the US business account)
- [ ] Webhook added at `https://<public-url>/webhooks/paypal` with the 5 events from section 3.1; `PAYPAL_WEBHOOK_ID` in `.env`
      (needs a public URL first, e.g. ngrok)
- [ ] Day-1 gate passes (results below; reauthorization can only be proven after the 3-day honor period)
  - [x] Authorize → void: PASS (run 2026-10-26, US payer; re-checked on PayPal 2026-10-27: authorization VOIDED)
  - [x] Authorize → capture: PASS (run 2026-10-26, GB payer paying USD; re-checked on PayPal 2026-10-27: capture COMPLETED, 5.00 USD)
  - [ ] Authorize → reauthorize → capture: PENDING. Not run yet. Run `pnpm gate:paypal --only reauth`; PayPal is expected
        to refuse inside the 3-day honor period, then retry with `pnpm gate:paypal --reauth <authId>` once it ends
        (about 30 Oct if authorized on 27 Oct).

### Sandbox accounts

Logins and passwords live only in `sandbox-accounts.local.md` (gitignored). Never commit them.

| Role | Type | Country | Demo name |
| --- | --- | --- | --- |
| Organizer (receives captures) | Business | US | — |
| Player 1 | Personal | US | Sam |
| Player 2 | Personal | GB | Ben |
| Player 3 | Personal | CA | Chai |
| Player 4 | Personal | NG | Tunde |

- Demo and gate currency: **USD**. Players in GB, CA and NG pay in USD; PayPal converts on their side.
- The default sandbox Business account (NG) belongs to an old app and is **not used**.

## 3.2 Telegram

- [ ] Bot created with @BotFather; `TELEGRAM_BOT_TOKEN` in `.env`
- [ ] `/setprivacy` → Disable
- [ ] Private test group with the bot and 2–3 test accounts
- [ ] `TELEGRAM_WEBHOOK_SECRET` chosen (deployment only; long polling locally)

## 3.3 Discord

- [ ] Application + bot created; `DISCORD_BOT_TOKEN` and `DISCORD_APPLICATION_ID` in `.env`
- [ ] Message Content Intent enabled
- [ ] Bot invited to a private test server with the scopes and permissions from section 3.3

## 3.4 Other accounts and tools

- [ ] Claude API key (`LLM_API_KEY`, `LLM_MODEL`)
- [ ] Render: web service, worker, PostgreSQL, static site
- [ ] AG Grid Enterprise hackathon license requested
- [ ] Bryntum Calendar hackathon license requested
- [ ] ngrok (or similar tunnel)
- [ ] Postman collection for PayPal sandbox calls
- [x] GitHub repo with `.env` in `.gitignore`

## 3.5 MCP servers (optional)

- [ ] PayPal MCP (sandbox only)
- [ ] AG Grid MCP
- [ ] Bryntum MCP

## PayPal day-1 gate results

Run with `pnpm gate:paypal` (all flows) or `pnpm gate:paypal --only void|capture|reauth`.
The script rewrites the blocks below on each run.

<!-- paypal-gate:start -->
<!-- gate:void:start -->
#### ✅ Authorize → void: PASS

- Run at 2026-10-26T20:56:04.780Z (UTC), sandbox, USD
- Order `0EP12692C8282383V` created (5.00 USD, intent AUTHORIZE)
- Approved by sandbox payer in US
- Authorization `7T321500V1343823C` status CREATED, expires 2026-11-24T20:56:00Z
- Voided `7T321500V1343823C` → status VOIDED
<!-- gate:void:end -->

<!-- gate:capture:start -->
#### ✅ Authorize → capture: PASS

- Run at 2026-10-26T20:58:01.278Z (UTC), sandbox, USD
- Order `6VH08910U35139843` created (5.00 USD, intent AUTHORIZE)
- Approved by sandbox payer in GB
- Authorization `4YA41088VW671772T` status CREATED, expires 2026-11-24T20:57:56Z
- Captured against `4YA41088VW671772T` → capture `0G0606318D0000046` status COMPLETED
<!-- gate:capture:end -->

<!-- gate:reauth:start -->
#### ✅ Authorize → reauthorize → capture: PASS

- Run at 2026-10-31T18:42:50.963Z (UTC), sandbox, USD
- Retrying held authorization `2VM29849T4246562N` (status CREATED, created 2026-10-26T21:04:26.000Z)
- Reauthorized `2VM29849T4246562N` → new authorization `1XG77204RF393664E` status CREATED
- Captured against `1XG77204RF393664E` → capture `0PC7636216032332V` status COMPLETED
<!-- gate:reauth:end -->

<!-- paypal-gate:end -->
