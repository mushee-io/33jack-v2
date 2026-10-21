# 33JACK V2 — audit (21 October 2026)

## Product
33JACK V2 is a multichannel AI finance operator and an agent-to-agent payment API, with a new wallet-signed Celo Mainnet stablecoin rail. Web, Telegram, WhatsApp and WeChat can submit/review invoices; external agents use authenticated REST endpoints. Human approval and an external EVM wallet signature are required for real transfers.

## Implemented and source-verified
- Separate GitHub 33jack-v2 and Vercel project.
- Legacy invoice intelligence, voice beta, experimental swipe, Solana Devnet, Wise Sandbox adapters and messaging channels retained.
- Celo USDC/USDT/USDm wallet-signed ERC-20 transfers, proposal idempotency, onchain proof, invoice status sync and messaging receipts.
- REST agent proposal/read/approve/confirm tools; channel-signed invoice handoff and RBAC checks.
- Celo security tests, legacy smoke tests, CI build and Hobby function-count guard.

## Hosting results
Earlier Vercel builds failed because the project exceeded the Hobby plan's 12 Serverless Functions. The V2 handlers were consolidated under api/v2.js, and api/payment.js was folded into api/payments.js. Later deployments were READY. GitHub smoke tests were updated accordingly. Vercel SSO protection is enabled.

## Unresolved production blockers
1. Connected Vercel project presently lists zero environment variables. This prevents real database-backed payments and configured messaging/AI services.
2. Legacy payment-list and agent-read endpoints do not enforce authenticated per-workspace user access. Do not expose customer data or turn off Vercel protection until this is fixed.
3. V2 human approvals currently use a shared browser-entered approval API key, not login, MFA, named approver identities or production audit-grade approval policies.
4. No independently verified real wallet payment has run through V2. CI transaction tests mock Celo RPC.
5. Celo transfers are wallet-to-wallet only; the demo route recommender is not live FX liquidity, regulated bank payouts or cross-chain bridging.
6. Messaging app handoff links exist, but provider webhook setup and embedded wallet compatibility have not been verified end-to-end.
7. The email agent, automatic payment/invoice followups, MCP/x402 server protocol, hosted agent SDK and provider-based fiat off-ramps have not been built.
8. Production compliance controls, KYC/KYB, sanctions checks, rate limiting, mobile wallet UX, account recovery and independent security review are still needed.

Recommended order: protect legacy data; add authenticated approvals and separate V2 database; configure secrets; supervised low-value Celo mainnet test; mobile wallet integration; agent/MCP/email workflows; compliant fiat off-ramp.

Passing CI and obtaining Vercel READY do not imply a safe, fully operational financial service.
