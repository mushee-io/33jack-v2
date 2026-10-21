# 33JACK V2 | AI Financial Operations and Celo Agent Infrastructure

New: MFA operator sessions, policy-guarded Celo transfers, MCP/A2A agent APIs, receipt attestations, Gmail invoice review, recurring approval queues, x402 adapter, stablecoin route quotes and SDKs. Production credentials, real low-value payments and independent security testing are still required.

[Full V2 build/deployment guide](docs/AGENT-PLATFORM-V2.md) | [Agent console](https://33jack-v2.vercel.app/agent-console.html) | [Finance inbox](https://33jack-v2.vercel.app/finance-ops.html)

# 33JACK V2 — Celo Mainnet + AI Agent Payment Infrastructure

**This is the separate V2 repository.** It retains the original 33JACK application and channels, while adding a new wallet-signed Celo Mainnet payment rail and agent-to-agent payment API. Celo transfers require explicit human approval and wallet signature. V1 demo FX flows remain demo-only.

**New V2 console:** `/app/celo` · **Setup, API and security guide:** [docs/CELO-V2.md](docs/CELO-V2.md)

---

# 33jack

**The autonomous finance operator for cross-border businesses.**

33jack turns a messy supplier-payment workflow into one controlled loop:

**invoice → AI checks → route proposal → exact approval → settlement → reconciliation**

The product is organized into three operating units behind one agent, plus a dedicated settlement infrastructure layer:

- **33Jack Pay** — stablecoin-funded local-currency payouts
- **33Jack Crypto** — stablecoin-to-stablecoin vendor / contractor payouts
- **33Jack Invoice** — invoice creation, extraction, verification and payment-state intelligence
- **Voice Pay (Beta)** — voice instruction → invoice preview → explicit approval
- **Jack Swipe (Beta)** — invoice notification → swipe approval → settlement → receipt, with risk-stop handoff
- **33Jack Settlement Network** — intent-based route discovery and deterministic scoring across chain and payout-provider adapters

This repository is the Colosseum MVP.

## What works now

- Premium business-finance dashboard with dedicated Pay, Crypto, Invoice and Settlement Network sections
- Real PDF / image / text invoice analysis through Groq when `GROQ_API_KEY` is configured
- Built-in structured invoice creator with Neon persistence and print/save-PDF workflow
- Deterministic demo analysis when an AI key is not configured
- Stored-history duplicate checks when Postgres is configured
- Risk review for suspicious invoices, missing data and beneficiary changes
- Exact human approval step before execution
- Solana Devnet USDG Token-2022 transfer adapter
- Safe simulated settlement when Devnet credentials are absent
- Payment-state API with Postgres persistence and an in-memory demo fallback
- Settlement receipt + reconciliation state
- Wise Sandbox quote + transfer creation with provider transfer IDs
- Wise transfer polling and signed webhook reconciliation
- Automatic Wise status mapping and final reconciliation
- Deterministic payout policy controls for currencies, country blocks, single-payment limits and KYB gating
- Agent-generated controlled payment proposals that hand off to the human-approved execution flow
- Voice Pay Beta for conversational payment preparation with on-screen approval
- Jack Swipe Beta for one-gesture approval of clean analysed invoices, with automatic stop-and-review for risk flags
- WhatsApp / Telegram / WeChat / Web product surfaces
- Workspace-scoped WhatsApp AI chat for finance questions and payment-review requests
- WhatsApp voice-note transcription through Groq Whisper before the same controlled agent flow
- WeChat Official Account secure callback with Token verification and EncodingAESKey/AES decryption
- WeChat workspace-scoped AI chat, invoice-image analysis, voice transcription, signed Review & Pay links and settlement receipts
- Responsive desktop + mobile UI
- CI build verification

## Product thesis

Businesses paying suppliers across borders do much more than click "send":

1. receive invoices
2. verify suppliers and beneficiary details
3. identify duplicates and suspicious changes
4. choose a payment / FX route
5. get internal approval
6. execute
7. chase failures and uncertain states
8. attach settlement evidence
9. reconcile the payment

33jack is the AI operator across that lifecycle.

## Architecture

```
Web / WhatsApp / Telegram / WeChat
            ↓
      33jack Agent
            ↓
 Invoice + Risk Analysis
            ↓
 Stored Business State
            ↓
 Exact Human Approval
            ↓
  Settlement Network
            ↓
 Smart deterministic router
            ↓
 Network + provider adapters
            ↓
 Recipient + reconciliation
```

AI prepares and explains. Deterministic controls constrain money movement.

## Runtime APIs

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | Analyse an invoice and prepare a structured payment/risk record |
| `POST /api/settle` | Execute Devnet USDG settlement when configured; otherwise return a safe demo settlement |
| `GET /api/payments` | Retrieve recent payment state |
| `POST /api/payments` | Persist/update a payment record |
| `GET /api/health` | Show which runtime integrations are configured |
| `POST /api/payout-quote` | Create an exact stablecoin-funded fiat payout quote |
| `POST /api/payout-approve` | Apply policy checks and bind human approval to exact payout terms |
| `POST /api/payout-settle` | Create the external sandbox transfer |
| `GET /api/payout-settle?payoutId=...` | Refresh provider state and reconcile external payouts |
| `POST /api/reconcile?provider=wise` | Verify signed Wise webhooks and reconcile state changes |
| `POST /api/agent` | Query finance state and prepare controlled payment proposals |
| `GET /api/settlement-health` | Read network/provider adapter status for the Settlement Network |
| `POST /api/settlement-quote` | Create a payment intent, evaluate settlement routes and return the recommended route plus alternatives |
| `POST /api/settlement-execute` | Run the explicitly-approved demo settlement flow and return a reconciled demo receipt |

## Settlement Network

The Settlement Network is a separate infrastructure section underneath the existing 33Jack products.

The business specifies the **payment intent** — source amount/currency, recipient currency/country and priority. 33Jack then evaluates the available network/provider combinations, applies deterministic policy and recommends the best valid route.

Current registry:

- **Solana** — Devnet adapter metadata using the existing settlement environment
- **Morph** — demo/test adapter, promoted only when real RPC configuration exists
- **Base** — demo/test adapter, promoted only when real RPC configuration exists
- **Wise Sandbox** — existing payout-provider environment represented as a provider adapter
- **Atlas Demo Rail / Orbit Demo Rail** — deterministic demo providers used to prove route discovery and comparison

Route scoring considers:

- total estimated cost
- FX spread
- settlement speed
- network/provider reliability
- preferred or blocked networks/providers
- minimum reliability and maximum fee/time policy

The Settlement Network UI is explicitly marked **DEMO** wherever the underlying rail is simulated. It does not fabricate transaction hashes or claim that mainnet/customer funds moved.

Architecture:

```
Payment Intent
      ↓
Risk + policy
      ↓
Exact approval
      ↓
Settlement Network
      ↓
Smart Router
      ↓
Solana / Morph / Base
      ↓
Wise / provider adapters
      ↓
Recipient
      ↓
Reconciliation
```

### Safety boundary

The route engine is deterministic. An LLM may explain the recommendation, but it does not choose or sign a payment. Ambiguous/irreversible production execution must stop for reconciliation instead of blindly falling back and risking a duplicate payment.

## Environment

Copy `.env.example` to `.env.local`.

```bash
GROQ_API_KEY=
GROQ_VISION_MODEL=qwen/qwen3.8-27b
GROQ_AGENT_MODEL=openai/gpt-oss-20b
GROQ_WHISPER_MODEL=whisper-large-v3-turbo

DATABASE_URL=

SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_DEVNET_USDG_MINT=4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7
SOLANA_SETTLEMENT_RECEIVER=
SOLANA_DEVNET_PAYER_SECRET_KEY=

MORPH_RPC_URL=
MORPH_CHAIN_ID=
MORPH_SETTLEMENT_WALLET=
MORPH_SETTLEMENT_PRIVATE_KEY=

BASE_RPC_URL=
BASE_CHAIN_ID=
BASE_SETTLEMENT_WALLET=
BASE_SETTLEMENT_PRIVATE_KEY=
```

`SOLANA_DEVNET_PAYER_SECRET_KEY` is a JSON array of the 64 secret-key bytes. Use a **Devnet-only wallet**. Never put a Mainnet private key in the project or client bundle.

## Run locally

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Deploy to Vercel

Vercel configuration is included in `vercel.json`.

[Deploy 33jack to Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmushee-io%2F33jack)

Framework: **Vite**

- Build command: `npm run build`
- Output directory: `dist`

After importing the repository, add the environment variables above in Vercel and redeploy.

## Devnet settlement

The settlement endpoint creates the recipient Token-2022 associated token account idempotently, reads the USDG mint decimals, transfers the approved amount, confirms the transaction on Solana Devnet and returns a Solana Explorer URL.

If the signer, mint, or recipient is not configured, the endpoint intentionally returns `mode: "demo"` and **does not move tokens**.

## AI invoice analysis

The analysis endpoint accepts PDF, image and text invoices. PDF inputs are sent as file inputs; image invoices are sent as vision inputs. The model is instructed not to invent missing commercial data and not to claim historical verification it has not performed.

When Postgres state exists, 33jack performs an additional stored-history duplicate check after the model extraction.

## Safety model

33jack should never give an LLM unrestricted signing authority.

- AI prepares a structured proposal
- deterministic validation constrains the execution path
- user approval binds to exact transaction details
- material changes require fresh approval
- settlement is server-side
- duplicate and uncertain states should block or escalate
- production local-currency payouts should use licensed / approved payment partners

## WhatsApp Cloud API channel

WhatsApp is the primary messaging demo channel for 33Jack.

Webhook callback:

`GET/POST /api/agent?provider=whatsapp`

The channel adapter supports:

- Meta webhook verification through `hub.verify_token`
- `X-Hub-Signature-256` HMAC verification using the Meta app secret
- inbound PDF, JPG and PNG invoice messages
- inbound WhatsApp voice notes transcribed with Groq Whisper
- normal workspace-scoped finance questions through the 33Jack Groq agent
- natural payment-review requests such as `Pay invoice NX-2026-0929-014`, returning a signed review link when a matching record exists
- webhook message-id deduplication and configured phone-number scoping to make Meta retries safe
- secure media retrieval through the WhatsApp Cloud API
- the same Groq invoice extraction and deterministic risk controls as the web app
- phone-namespaced workspaces so one WhatsApp user cannot read another user's finance state
- short-lived signed review links bound to the exact WhatsApp user, workspace and payment
- server-side role rechecks immediately before approval and settlement
- settlement receipts returned to the originating WhatsApp chat with idempotency protection
- `STATUS` for workspace payment, risk and payout counts
- `TEAM`, `INVITE <role>`, `JOIN <code>` and `ROLE <number> <role>` for workspace access controls
- `BENEFICIARIES`, `BLOCK ...`, `ALLOW ...` and `REVIEW ...` for beneficiary policy controls
- `NOTIFY` and `NOTIFY <category> <ON|OFF>` for messaging preferences
- `PAYOUTS` and `TRACK <payout-id>` for workspace-scoped payout / Wise sandbox tracking
- secure handoff back to the exact 33Jack payment approval flow
- server-side outbound replies through the configured WhatsApp phone-number ID

Required environment:

```bash
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_GRAPH_VERSION=v26.0
PUBLIC_APP_URL=https://33jack.vercel.app
```

The Meta app webhook should use your deployed callback URL, for example:

`https://33jack.vercel.app/api/agent?provider=whatsapp`

Subscribe the WhatsApp app to the `messages` webhook field. Keep access tokens and the app secret out of the browser bundle and repository.

### WhatsApp demo commands

```text
HELP
What payments need my attention?
Pay invoice NX-2026-0929-014
Has Nexora been paid?
STATUS
TEAM
INVITE approver
JOIN ABC123
ROLE 2 approver
BENEFICIARIES
BLOCK Supplier Name | CNY | beneficiary details changed
ALLOW Supplier Name | CNY
REVIEW Supplier Name | CNY | manual review required
NOTIFY
NOTIFY RECEIPTS OFF
PAYOUTS
TRACK payout_xxx
```

Invoice documents and images continue through the controlled flow:
**upload → extraction/risk checks → signed exact-payment review link → role-checked approval → settlement → receipt back in WhatsApp**.



## WeChat Official Account channel

33Jack supports a WeChat/Weixin Official Account or Service Account as a controlled finance-operator channel.

Callback URL:

`GET/POST /api/agent?provider=wechat`

The adapter supports:

- WeChat server URL verification using the configured `WECHAT_TOKEN`
- plaintext callbacks for initial debugging
- secure AES callback decryption using `WECHAT_ENCODING_AES_KEY`
- AppID validation after encrypted payload decryption
- OpenID-namespaced workspaces so one WeChat user cannot read another workspace
- normal workspace-scoped finance questions through the same Groq agent
- inbound invoice images through WeChat temporary-media retrieval
- inbound WeChat voice messages transcribed with Groq Whisper
- `STATUS`, `TEAM`, `INVITE <role>` and `JOIN <code>`
- natural payment-review requests such as `Pay invoice NX-2026-0929-014`
- short-lived signed Review & Pay links bound to the exact OpenID, workspace and payment
- server-side role rechecks before approval and settlement
- settlement receipts returned through the WeChat customer-service message API
- message-ID deduplication to tolerate WeChat callback retries

Required environment:

```bash
WECHAT_APP_ID=
WECHAT_APP_SECRET=
WECHAT_TOKEN=
WECHAT_ENCODING_AES_KEY=
WECHAT_REVIEW_SECRET=
PUBLIC_APP_URL=https://33jack.vercel.app
```

Configure the Official Account server URL as:

`https://33jack.vercel.app/api/agent?provider=wechat`

For production, use WeChat **Security Mode** once URL verification succeeds. The callback is XML-based and 33Jack decrypts the encrypted `Encrypt` envelope server-side.

Outbound customer-service messages use the Official Account access token obtained server-side from `WECHAT_APP_ID` + `WECHAT_APP_SECRET`. Some WeChat account configurations require the server egress IP to be allowlisted; if WeChat returns an IP-whitelist error, use a stable outbound IP/proxy or a hosting setup with fixed egress.

The controlled flow remains:

**WeChat message / invoice image / voice → 33Jack AI + deterministic risk → signed Review & Pay → exact approval → settlement → receipt back in WeChat**.

## Wise Sandbox webhook

33Jack accepts Wise transfer events at:

`POST /api/reconcile?provider=wise`

Webhook requests are verified with Wise's RSA/SHA-256 `X-Signature-SHA256` signature before any payout state is changed. The handler supports transfer state changes, payout failures and refunds, ignores older out-of-order events, and writes audit events.

For a profile-level sandbox subscription, configure the Wise callback to your deployed HTTPS URL and subscribe to `transfers#state-change` using schema `4.0.0`. Polling remains available as a recovery path.

## Production boundary

The codebase now covers the controlled software workflow through external-provider sandbox reconciliation. Moving real customer funds still requires external production dependencies that cannot be created by this repository alone:

- a licensed stablecoin off-ramp / liquidity partner for the stablecoin-to-fiat funding leg
- production Wise or another approved payout-provider access
- business KYB/KYC and sanctions / transaction-monitoring providers
- an authenticated organization/user model for real multi-user maker-checker approvals
- production legal, custody and compliance approval for each supported corridor

33Jack intentionally reports production money movement as unavailable until those dependencies are configured and approved.

## Next integrations after provider onboarding

- live stablecoin off-ramp adapter
- organization authentication + multi-user maker/checker roles
- secure WhatsApp / Telegram / WeChat ingestion
- accounting-system export / sync

---

Built for Colosseum on Solana.
