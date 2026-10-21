# 33JACK V2 — Celo Mainnet integration

33JACK V2 is a separate repository from V1. It retains existing web, Telegram, WhatsApp and WeChat functionality (where credentials/provider onboarding are configured). The new Celo rail is an **independent wallet-signed mainnet payment path**, not an automatic upgrade of the legacy Solana Devnet or demo FX paths.

## Celo network
- Chain ID: 42220 (0xa4ec)
- Default JSON RPC: https://forno.celo.org
- Explorer: https://celoscan.io
- Stablecoins: native USDC 0xcebA9300f2b948710d2653dD7B07f33A8B32118C (6 decimals); USDT 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e (6 decimals); cUSD 0x765DE816845861e75A25fCA122bb6898B8B1282a (18 decimals).
- Primary references: https://github.com/celo-org/celo-token-list ; https://docs.celo.org/ ; https://viem.sh/docs/chains/celo

## Configure Vercel
Set the following **server-side environment variables**, then deploy V2 (do not reuse V1 secrets):
- DATABASE_URL — independent Neon/Postgres V2 database (required for all agent proposals).
- JACK_AGENT_API_KEYS_JSON — JSON object mapping each agent ID to its own random key (32+ characters), for example {"partner-agent":"REPLACE_WITH_32_PLUS_RANDOM_CHARACTERS"}.
- JACK_APPROVAL_API_KEY — a distinct random 32+ character secret reserved for the authorised human-approval step.
- CELO_RPC_URL — optional HTTPS RPC URL (defaults to public Forno).
- CELO_MAX_PAYMENT_USD — nominal per-intent stablecoin cap (defaults to 100).
- CELO_MIN_CONFIRMATIONS — required onchain confirmations (defaults to 2; supported 1–100).

Generate keys using a secure secrets manager or Node's crypto.randomBytes(32). Store them in Vercel only; never in source control or VITE_* variables. Use a separate V2 database to avoid accidentally mixing production financial records with V1. Consider rate limits, audit logs, a secrets vault and production-grade user approvals before allowing broader production users.

## API / agent-to-agent tools
- GET /api/v2/celo — public Celo RPC/chain/token configuration.
- GET /api/v2/celo?operation=health — checks actual JSON-RPC chain ID.
- GET /api/v2/agent?operation=tools — public tool discovery (no payment mutation).
- POST /api/v2/agent?operation=propose — creates exact, replay-protected Celo stablecoin proposal.
- GET /api/v2/agent?operation=intent&id=UUID — reads proposal and returns unsigned transfer payload **only after approval**.
- POST /api/v2/agent?operation=approve — privileged human approval step, separate approval key.
- POST /api/v2/agent?operation=confirm — verifies matching onchain ERC-20 Transfer event, chain ID, recipient, exact amount, optional payer, post-approval block timestamp, confirmations and unique transaction hash.

All private endpoints require headers: x-jack-agent-id and Authorization: Bearer AGENT_KEY. Propose additionally requires Idempotency-Key (8–128 alphanumeric/underscore/dot/colon/dash characters); approve requires x-jack-approval-key plus confirmation of the precise ID. Approved proposals expire after 30 minutes. Each API key only accesses its own agent's proposals.

Example proposal (authenticated with actual keys):
    POST /api/v2/agent?operation=propose
    Idempotency-Key: partner-unique-00001
    Content-Type: application/json
    {"token":"USDC","amount":"1.25","recipient":"0x1111111111111111111111111111111111111111","payer":"0x2222222222222222222222222222222222222222","memo":"Invoice #42"}

Then approve with JSON {"id":"PROPOSAL_UUID","confirmation":"APPROVE:PROPOSAL_UUID"} plus human approval header.
Retrieve unsigned transfer data, review recipient and amount, **sign through an EVM wallet**, then submit {"id":"PROPOSAL_UUID","txHash":"0x..."} to confirm.

### Security, boundaries and status
- Agent proposals are noncustodial: 33JACK does **not** hold a wallet private key and never autonomously sends funds.
- Agents cannot trigger approval without the distinct human-approval credential. The browser demo requires a conscious click and confirmation; production should replace shared approval keys with authenticated operator identity, MFA, RBAC, and auditable multi-party controls.
- Settlement is **onchain ERC-20 wallet transfer only**, NOT a fiat-bank payout or an automatic bridging/FX conversion.
- Celo Mainnet payment records are stored only if DATABASE_URL is configured. No in-memory "fake settled" fallback exists for V2.
- Never treat a demo route quote as a live FX price; V1 settlement-network scoring is illustrative.
- No claim of smart-contract audit, compliance certification, or production bank-payout support.

## Chat-channel & invoice handoff (V2)

Web invoice-agent responses offer **Prepare wallet-signed Celo payment**, which opens the Celo screen and pre-fills only the invoice reference, not an unverified amount or beneficiary. Users can still use third-party agents via the authenticated V2 agent API.

Telegram invoice messages and Mini App dashboard now show Celo review links. WhatsApp and WeChat existing signed invoice review messages also include a Celo checkout link. These integrations reuse the existing bot session and shared workspace permission records; existing V1 review and settlement links remain available.

The V2 channel API is POST-only: /api/v2/channel?operation=context|propose|approve|refresh|confirm. It requires a Telegram signed Mini App session and launch token, or a short-lived signed WhatsApp/WeChat review token; the server verifies the invoice belongs to that workspace and the member has the correct capability. Propose requires operator privileges, the connected payer address, explicit wallet/amount confirmation and acknowledgement of any duplicate / beneficiary-change / suspicious risk. Missing invoice fields block payment. Approval requires an approver role **and** the separate JACK_APPROVAL_API_KEY plus an exact comparison with the original saved terms. Wallet signing remains mandatory; reconciliation checks exact onchain details. Channel proposals are unique per workspace/invoice across all chat channels via database idempotency.

The channel review link is a bearer credential for WhatsApp/WeChat and expires after 15 minutes. A separate human approval credential is required; handle review links securely. Existing channel integrations **will not** work unless their provider keys, callback webhooks, workspace permissions and V2 database are configured. Celo payment intent expiry remains 30 minutes.

**Limitations:** A WhatsApp/WeChat signed link alone does not prove the current browser user owns that messaging account. Do not weaken the separate human-approval credential or wallet-signature requirements. A production rollout should use user accounts + MFA/role-managed approval instead of sharing an operator approval API key. Celo is a wallet-to-wallet rail, not fiat payouts or automatic FX.

After a Celo onchain transfer is verified, channel reconciliation also mirrors `settled_celo` and the transaction hash to the V2 invoice dashboard. If this secondary sync fails, `invoiceSynced:false` is returned and the idempotent confirm endpoint can retry without a second payment.
