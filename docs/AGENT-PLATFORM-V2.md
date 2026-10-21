# 33JACK V2 Agent Platform — Build and deployment guide
Date: 21 October 2026.

This release is a source implementation, NOT a claim of completed public-mainnet financial operations. A successful Vercel build only proves that the code compiled and deployed.

## Implemented
- Separate 33JACK V2 repository and Vercel project, Celo Mainnet USDC/USDT/USDm transfers.
- Independent RPC checks for exact signed transfer, payer, token, ABI calldata, value, chain ID, block confirmation and matching ERC-20 event.
- Operator MFA with password + TOTP, signed HttpOnly cookie, database-backed login throttling and named approval audit fields.
- Legacy finance APIs fail closed until single-business owner/admin explicitly enables global access. No multi-tenant claim.
- Agent policy allowlists for payer, recipient, token, per-transaction and per-day nominal USD. External agent approvals reevaluate budgets under a database transaction lock.
- REST, MCP JSON-RPC and synchronous A2A JSON-RPC agent interfaces; Celo machine-readable receipts and Python/JavaScript SDKs.
- Gmail readonly OAuth inbox synchronisation, metadata extraction and manual review; no automatic pay action.
- Scheduled payment review queue through a daily Vercel cron and separate manual intent preparation.
- Optional x402 version 2 paid invoice risk screening with configured mainnet facilitator and durable transaction replay control. Off by default.
- Celo public RPC read-only route comparison between policy-allowed USD stablecoins, gas denominated in native CELO rather than invented fiat FX quotes.

## Operations URLs
- /login.html — operator login.
- /app/celo — external wallet checkout and onchain reconciliation.
- /finance-ops.html — Gmail invoice review.
- /agent-console.html — configure policies, recurring schedules and human review queue.
- /api/v2/agent?operation=tools — public tool catalog.
- /mcp — HTTP POST MCP JSON-RPC, tools/list and tools/call.
- /.well-known/agent-card.json — A2A AgentCard.
- /a2a — A2A message/send with structured data part, not natural-language payment execution.
- /api/v2/receipt?id=UUID — authenticated confirmed receipt.
- /api/v2/routes — authenticated Celo asset-balance/gas quote comparison.
- /api/v2/x402?operation=pricing — x402 price discovery only when facilitator configured.

## Production secrets (server-side Vercel settings)
1. DATABASE_URL — independent V2 Neon database; do not reuse V1 production financial data.
2. JACK_SESSION_SECRET — unique random 48+ character cookie signing secret.
3. JACK_OPERATORS_JSON — object with user roles and passwordSalt/passwordHash generated locally via JACK_NEW_OPERATOR_PASSWORD=... node scripts/generate-operator.mjs owner; register TOTP seed in authenticator. No operator is preconfigured.
4. JACK_AGENT_API_KEYS_JSON — per-agent unique random keys 32+ characters.
5. CELO_RPC_URL — reliable Celo Mainnet HTTPS RPC endpoint.
6. JACK_EMAIL_WORKSPACE_ID, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — Gmail readonly scope under the business owner's consent.
7. JACK_SCHEDULE_WORKSPACE_ID and CRON_SECRET — daily Vercel schedule service, not instant processing.
8. JACK_X402_RECEIVER, JACK_X402_PRICE_UNITS, JACK_X402_FACILITATOR_URL, JACK_X402_FACILITATOR_API_KEY — Celo exact/USDC facilitator credentials. Ensure production eip155:42220 support and test before taking payment.
9. Existing Telegram, WhatsApp, WeChat provider credentials and callback signatures.
10. Never set JACK_ALLOW_LEGACY_APPROVAL_KEY in public production unless doing a separately secured, temporary migration.
11. JACK_ADMIN_SCOPE=global unlocks legacy single-admin finance data across unscoped records after MFA. Avoid it in multi-customer operations.

## Setup and local verification
    npm install
    npm run test:vercel
    npm run test:celo
    npm run test:platform
    npm run test:smoke
    npm run build

## Before real customer funds
- Set isolated database secrets, register operator, verify MFA and agent policy permissions.
- Use a supervised low-value wallet-to-wallet Celo USDC payment, record the explorer transaction and compare with receipt.
- Validate end-to-end bot provider signatures and embedded EVM wallet support on actual mobile devices.
- Confirm recipient ownership and compliance, and have contracts/account separation independently reviewed.
- No smart-account autonomous key delegation contract, bridge, licensed bank payouts, automatic FX or multi-tenant finance migration is represented as live in this build.
- Vercel Hobby cron is at most daily and imprecise; scheduled reviews are not automatic transfers.
- 33JACK's historical Solana Devnet/Wise Sandbox functions are retained for migration and are not proof of mainnet banking support.

Deployment-ready does not mean money-ready.

## Owner bootstrap and short-lived agent tokens

Visit /setup.html on the access-protected V2 deployment. Retrieve JACK_BOOTSTRAP_SECRET inside Vercel project settings; do not send this secret through chat. Create your own strong password, enter the generated TOTP seed in an authenticator, and finish enrolment with a six-digit code. V2 encrypts TOTP seeds in the independent Neon database and blocks further first-owner bootstraps after success.

Required environment: JACK_OPERATOR_DB_AUTH=true, JACK_PRIMARY_WORKSPACE_ID, JACK_BOOTSTRAP_SECRET, JACK_AGENT_TOKEN_SECRET, JACK_SESSION_SECRET, DATABASE_URL. Agent token issuance in /agent-console.html requires an MFA owner, an enabled allowlist policy and produces a signed 1-to-24-hour key. It is shown only once. Rotate JACK_AGENT_TOKEN_SECRET for emergency revocation; old tokens otherwise expire within 24 hours. No key permits a wallet transfer without human MFA approval and the user's wallet signature.
