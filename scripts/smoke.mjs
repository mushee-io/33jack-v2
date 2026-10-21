import assert from "node:assert/strict";
import crypto from "node:crypto";
import analyze from "../api/analyze.js";
import agent from "../api/agent.js";
import approve from "../api/approve.js";
import settle from "../api/settle.js";
// Payment detail is served by the consolidated payments handler.
import payments from "../api/payments.js";
import health from "../api/health.js";
import reconcile from "../api/reconcile.js";
import payoutQuote from "../api/payout-quote.js";
import payoutApprove from "../api/payout-approve.js";
import payoutSettle from "../api/payout-settle.js";
import { assignPaymentWorkspace, getOrCreateTelegramWorkspace, listAuditEvents } from "../api/_lib/db.js";
import { signWhatsAppLaunch } from "../api/_lib/whatsapp-auth.js";
import { getPayout, savePayout } from "../api/_lib/payout-store.js";
import { getPayoutQuote, executeExternalPayout, getPayoutProviderReadiness } from "../api/_lib/payout-provider.js";
import { evaluatePayoutPolicy } from "../api/_lib/policy.js";
import { signTelegramLaunch } from "../api/_lib/telegram-auth.js";

function invoke(handler, method = "GET", body = undefined, query = undefined, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, body, query: query || {}, headers };
    const res = {
      code: 200,
      status(code) { this.code = code; return this; },
      json(data) { resolve({ status: this.code, data }); return this; },
      end() { resolve({ status: this.code, data: null }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const whatsappReview = (req, res) => {
  req.query = { ...(req.query || {}), provider: "whatsapp-review" };
  return agent(req, res);
};

function invokeRaw(handler, method, rawBody, query = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      query,
      headers,
      async *[Symbol.asyncIterator]() {
        if (rawBody?.length) yield rawBody;
      }
    };
    const res = {
      code: 200,
      status(code) { this.code = code; return this; },
      json(data) { resolve({ status: this.code, data }); return this; },
      end() { resolve({ status: this.code, data: null }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

process.env.OPENAI_API_KEY = "";
process.env.DATABASE_URL = "";
process.env.SOLANA_DEVNET_PAYER_SECRET_KEY = "";
process.env.SOLANA_SETTLEMENT_RECEIVER = "";
process.env.APPROVAL_HMAC_SECRET = "ci-smoke-secret";
process.env.NODE_ENV = "test";
process.env.JACK_LEGACY_TEST_ACCESS = "enabled";

const invoice = Buffer.from(
  "INVOICE 33J-CI-1\nSupplier: Austin Software Inc.\nAmount due: GBP 4850\nTarget: USD",
  "utf8"
).toString("base64");

const first = await invoke(analyze, "POST", {
  fileName: "ci-invoice.txt",
  mimeType: "text/plain",
  fileData: invoice,
  corridor: "USD"
});

assert.equal(first.status, 200);
assert.ok(first.data.id);
assert.equal(first.data.destination_currency, "USD");
assert.ok(first.data.recommended_route);
assert.equal(first.data.risk.duplicate, false);
assert.ok(first.data.invoice_hash);

const approval = await invoke(approve, "POST", {
  paymentId: first.data.id,
  acknowledgements: {},
  amountUsdc: 1
});

assert.equal(approval.status, 200);
assert.ok(approval.data.approvalToken);

const settlement = await invoke(settle, "POST", {
  approvalToken: approval.data.approvalToken
});

assert.equal(settlement.status, 200);
assert.equal(settlement.data.mode, "demo");
assert.ok(settlement.data.signature.startsWith("demo_"));

const replay = await invoke(settle, "POST", {
  approvalToken: approval.data.approvalToken
});
assert.equal(replay.status, 200);
assert.equal(replay.data.idempotent, true);
assert.equal(replay.data.signature, settlement.data.signature);

const detail = await invoke(payments, "GET", undefined, { kind: "detail", id: first.data.id });
assert.equal(detail.status, 200);
assert.equal(detail.data.payment.status, "settled_demo");
assert.ok(detail.data.events.length >= 3);

// Analyze the exact same invoice again. The deterministic SHA-256 fingerprint
// must detect the duplicate even without AI.
const duplicate = await invoke(analyze, "POST", {
  fileName: "ci-invoice-copy.txt",
  mimeType: "text/plain",
  fileData: invoice,
  corridor: "USD"
});
assert.equal(duplicate.status, 200);
assert.equal(duplicate.data.risk.duplicate, true);

const blockedApproval = await invoke(approve, "POST", {
  paymentId: duplicate.data.id,
  acknowledgements: {},
  amountUsdc: 1
});
assert.equal(blockedApproval.status, 400);
assert.match(blockedApproval.data.detail, /acknowledgement/i);

const acknowledgedApproval = await invoke(approve, "POST", {
  paymentId: duplicate.data.id,
  acknowledgements: { duplicate: true },
  amountUsdc: 1
});
assert.equal(acknowledgedApproval.status, 200);
assert.ok(acknowledgedApproval.data.approvalToken);

const createdInvoice = await invoke(payments, "POST", {
  kind: "invoice",
  invoiceNumber: "33J-CI-INVOICE-1",
  supplier: "CI Supplier Ltd",
  customer: "Mushee Labs",
  amount: 5000,
  currency: "USD",
  dueDate: "2026-10-10",
  description: "Engineering services"
});
assert.equal(createdInvoice.status, 200);
assert.equal(createdInvoice.data.invoice.invoice_number, "33J-CI-INVOICE-1");
assert.equal(createdInvoice.data.invoice.route, "invoice_draft");
assert.equal(createdInvoice.data.invoice.invoice_meta.customer, "Mushee Labs");

const invoiceList = await invoke(payments, "GET", undefined, { kind: "invoices", limit: 10 });
assert.equal(invoiceList.status, 200);
assert.ok(invoiceList.data.invoices.some((invoice) => invoice.invoice_number === "33J-CI-INVOICE-1"));

process.env.PAYOUT_SINGLE_LIMIT_USD = "500";
const blockedPolicy = evaluatePayoutPolicy({
  funding_amount: 1000,
  destination_currency: "CNY",
  beneficiary: { country: "China" }
});
assert.equal(blockedPolicy.allowed, false);
assert.match(blockedPolicy.reasons.join(" "), /single-payment limit/i);
delete process.env.PAYOUT_SINGLE_LIMIT_USD;

const fiatQuote = await invoke(payoutQuote, "POST", {
  fundingAsset: "USDG",
  fundingAmount: 10000,
  destinationCurrency: "CNY",
  invoiceRef: "33J-CI-FIAT-1",
  beneficiary: {
    name: "CI Supplier Ltd",
    bank_name: "CI Bank",
    account_last4: "5678",
    country: "China"
  }
});
assert.equal(fiatQuote.status, 200);
assert.equal(fiatQuote.data.payout.status, "quoted");
assert.equal(fiatQuote.data.payout.funding_asset, "USDG");
assert.equal(fiatQuote.data.payout.destination_currency, "CNY");
assert.ok(Number(fiatQuote.data.payout.destination_amount) > 0);

const refreshedFiatQuote = await invoke(payoutQuote, "POST", {
  payoutId: fiatQuote.data.payout.id,
  fundingAsset: "USDG",
  fundingAmount: 10000,
  destinationCurrency: "CNY",
  invoiceRef: "33J-CI-FIAT-1",
  beneficiary: {
    name: "CI Supplier Ltd",
    bank_name: "CI Bank",
    account_last4: "5678",
    country: "China"
  }
});
assert.equal(refreshedFiatQuote.status, 200);
assert.equal(refreshedFiatQuote.data.payout.id, fiatQuote.data.payout.id);
assert.equal(refreshedFiatQuote.data.payout.status, "quoted");

const fiatApproval = await invoke(payoutApprove, "POST", {
  payoutId: fiatQuote.data.payout.id
});
assert.equal(fiatApproval.status, 200);
assert.ok(fiatApproval.data.approvalToken);

// Mimic Postgres JSONB returning beneficiary keys in a different order.
const approvedStoredPayout = await getPayout(fiatQuote.data.payout.id);
await savePayout({
  ...approvedStoredPayout,
  beneficiary: {
    country: approvedStoredPayout.beneficiary.country,
    account_last4: approvedStoredPayout.beneficiary.account_last4,
    bank_name: approvedStoredPayout.beneficiary.bank_name,
    name: approvedStoredPayout.beneficiary.name
  }
});

const fiatSettlement = await invoke(payoutSettle, "POST", {
  approvalToken: fiatApproval.data.approvalToken
});
assert.equal(fiatSettlement.status, 200);
assert.equal(fiatSettlement.data.payout.status, "paid_sandbox");
assert.ok(fiatSettlement.data.receipt.id.startsWith("33J-FIAT-"));
assert.equal(fiatSettlement.data.receipt.reconciled, true);
assert.equal(fiatSettlement.data.receipt.beneficiary, "CI Supplier Ltd");
assert.equal(fiatSettlement.data.receipt.bank, "CI Bank");
assert.equal(fiatSettlement.data.receipt.account_last4, "5678");

const payoutList = await invoke(payments, "GET", undefined, { kind: "payouts", limit: 10 });
assert.equal(payoutList.status, 200);
assert.ok(payoutList.data.payouts.some((p) => p.id === fiatQuote.data.payout.id));
assert.equal(
  payoutList.data.payouts.filter((p) => p.invoice_ref === "33J-CI-FIAT-1").length,
  1
);

const originalFetch = globalThis.fetch;
process.env.PAYOUT_PROVIDER = "wise_sandbox";
process.env.WISE_SANDBOX_TOKEN = "ci-wise-token";
process.env.WISE_PROFILE_ID = "12345";
process.env.WISE_RECIPIENT_ACCOUNT_ID = "67890";
delete process.env.WISE_BALANCE_ID;
let wiseMockStatus = "incoming_payment_waiting";

globalThis.fetch = async (url, options = {}) => {
  const path = String(url);
  if (path.includes("/profiles/12345/quotes")) {
    return new Response(JSON.stringify({
      id: "8fa9be20-ba43-4b15-abbb-9424e1481050",
      sourceAmount: 1000,
      targetAmount: 7120,
      rate: 7.12,
      rateExpirationTime: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      paymentOptions: [{ fee: { total: 6.5 }, estimatedDelivery: "sandbox estimate" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (path.endsWith("/transfers") && options.method === "POST") {
    return new Response(JSON.stringify({
      id: 16521632,
      status: "incoming_payment_waiting",
      quoteUuid: "8fa9be20-ba43-4b15-abbb-9424e1481050",
      targetAccount: 67890
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (path.endsWith("/transfers/16521632") && options.method === "GET") {
    return new Response(JSON.stringify({
      id: 16521632,
      status: wiseMockStatus
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (path.includes("/transfers/16521632/payments") && options.method === "POST") {
    return new Response(JSON.stringify({ message: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ error: "unexpected test request" }), {
    status: 500,
    headers: { "Content-Type": "application/json" }
  });
};

const wiseReadiness = getPayoutProviderReadiness();
assert.equal(wiseReadiness.provider, "wise_sandbox");
assert.equal(wiseReadiness.wiseQuoteReady, true);
assert.equal(wiseReadiness.wiseTransferReady, true);

const wiseQuote = await getPayoutQuote({
  payoutId: "payout-wise-ci",
  invoiceRef: "WISE-CI-1",
  fundingAsset: "USDG",
  fundingAmount: 1000,
  destinationCurrency: "CNY"
});
assert.equal(wiseQuote.provider, "wise_sandbox");
assert.equal(wiseQuote.providerQuoteId, "8fa9be20-ba43-4b15-abbb-9424e1481050");
assert.equal(wiseQuote.destinationAmount, 7120);
assert.equal(wiseQuote.feeAmount, 6.5);

const wiseTransfer = await executeExternalPayout({
  id: "payout-wise-ci",
  invoice_ref: "WISE-CI-1",
  quote: wiseQuote
});
assert.equal(wiseTransfer.provider, "wise_sandbox");
assert.equal(wiseTransfer.transferId, "16521632");
assert.equal(wiseTransfer.providerStatus, "incoming_payment_waiting");
assert.equal(wiseTransfer.funded, false);

process.env.WISE_BALANCE_ID = "999";
process.env.WISE_AUTO_FUND = "true";

const externalQuoteResponse = await invoke(payoutQuote, "POST", {
  fundingAsset: "USDG",
  fundingAmount: 1000,
  destinationCurrency: "CNY",
  invoiceRef: "WISE-CI-E2E-1",
  beneficiary: {
    name: "Wise CI Supplier",
    bank_name: "Wise CI Bank",
    account_last4: "5678",
    country: "China"
  }
});
assert.equal(externalQuoteResponse.status, 200);
assert.equal(externalQuoteResponse.data.payout.quote.provider, "wise_sandbox");
assert.equal(
  externalQuoteResponse.data.payout.quote.providerQuoteId,
  "8fa9be20-ba43-4b15-abbb-9424e1481050"
);

const externalApprovalResponse = await invoke(payoutApprove, "POST", {
  payoutId: externalQuoteResponse.data.payout.id
});
assert.equal(externalApprovalResponse.status, 200);
assert.ok(externalApprovalResponse.data.approvalToken);

const externalSettlementResponse = await invoke(payoutSettle, "POST", {
  approvalToken: externalApprovalResponse.data.approvalToken
});
assert.equal(externalSettlementResponse.status, 200);
assert.equal(externalSettlementResponse.data.payout.status, "external_created");
assert.equal(externalSettlementResponse.data.receipt.id, "WISE-16521632");
assert.equal(externalSettlementResponse.data.receipt.provider, "Wise Sandbox");
assert.equal(
  externalSettlementResponse.data.receipt.provider_status,
  "incoming_payment_waiting"
);
assert.equal(externalSettlementResponse.data.receipt.reconciled, false);
assert.equal(externalSettlementResponse.data.provider.funded, false);
assert.equal(externalSettlementResponse.data.provider.manualFundingRequired, true);
assert.equal(
  externalSettlementResponse.data.provider.fundingStatus,
  "MANUAL_OR_SCA_REQUIRED"
);

const { publicKey: webhookPublicKey, privateKey: webhookPrivateKey } =
  crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.WISE_WEBHOOK_PUBLIC_KEY = webhookPublicKey
  .export({ type: "spki", format: "pem" })
  .toString();

const webhookPayload = Buffer.from(JSON.stringify({
  data: {
    resource: { type: "transfer", id: 16521632, profile_id: 12345, account_id: 67890 },
    current_state: "funds_converted",
    previous_state: "processing",
    occurred_at: "2026-09-28T18:00:00.000Z"
  },
  subscription_id: "ci-subscription",
  event_type: "transfers#state-change",
  schema_version: "4.0.0",
  sent_at: "2026-09-28T18:00:00.100Z"
}));
const webhookSignature = crypto
  .sign("RSA-SHA256", webhookPayload, webhookPrivateKey)
  .toString("base64");
const webhookResponse = await invokeRaw(
  reconcile,
  "POST",
  webhookPayload,
  { provider: "wise" },
  {
    "x-signature-sha256": webhookSignature,
    "x-delivery-id": "ci-delivery-1"
  }
);
assert.equal(webhookResponse.status, 200);
assert.equal(webhookResponse.data.matched, true);
assert.equal(webhookResponse.data.status, "processing_external");
assert.equal(webhookResponse.data.providerStatus, "funds_converted");
delete process.env.WISE_WEBHOOK_PUBLIC_KEY;

wiseMockStatus = "outgoing_payment_sent";
const trackedExternal = await invoke(
  payoutSettle,
  "GET",
  undefined,
  { payoutId: externalSettlementResponse.data.payout.id }
);
assert.equal(trackedExternal.status, 200);
assert.equal(trackedExternal.data.payout.status, "reconciled_external");
assert.equal(trackedExternal.data.tracking.providerStatus, "outgoing_payment_sent");
assert.equal(trackedExternal.data.receipt.reconciled, true);
assert.equal(trackedExternal.data.receipt.status, "PAID (WISE SANDBOX)");

globalThis.fetch = originalFetch;
process.env.PAYOUT_PROVIDER = "internal_sandbox";
delete process.env.WISE_SANDBOX_TOKEN;
delete process.env.WISE_PROFILE_ID;
delete process.env.WISE_RECIPIENT_ACCOUNT_ID;
delete process.env.WISE_BALANCE_ID;
delete process.env.WISE_AUTO_FUND;

process.env.WHATSAPP_ACCESS_TOKEN = "ci-whatsapp-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_VERIFY_TOKEN = "ci-whatsapp-verify";
process.env.WHATSAPP_APP_SECRET = "ci-whatsapp-app-secret";
process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
process.env.PUBLIC_APP_URL = "https://33jack.example";

const whatsappOriginalFetch = globalThis.fetch;
let whatsappOutboundMessages = 0;
globalThis.fetch = async (url, options = {}) => {
  const value = String(url);
  if (value.includes("graph.facebook.com") && value.endsWith("/123456789/messages")) {
    whatsappOutboundMessages += 1;
    return new Response(JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ input: "447000000000", wa_id: "447000000000" }],
      messages: [{ id: "wamid.ci" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return whatsappOriginalFetch(url, options);
};

const whatsappPayload = {
  object: "whatsapp_business_account",
  entry: [{
    id: "ci-waba",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "441234567890",
          phone_number_id: "123456789"
        },
        contacts: [{ profile: { name: "CI User" }, wa_id: "447000000000" }],
        messages: [{
          from: "447000000000",
          id: "wamid.incoming",
          timestamp: "1780000000",
          type: "text",
          text: { body: "hello" }
        }]
      }
    }]
  }]
};
const whatsappRaw = JSON.stringify(whatsappPayload);
const whatsappSignature = "sha256=" + crypto
  .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
  .update(Buffer.from(whatsappRaw))
  .digest("hex");

const badWhatsapp = await invoke(
  agent,
  "POST",
  whatsappPayload,
  { provider: "whatsapp" },
  { "x-hub-signature-256": "sha256=deadbeef" }
);
assert.equal(badWhatsapp.status, 401);

const whatsappHello = await invoke(
  agent,
  "POST",
  whatsappPayload,
  { provider: "whatsapp" },
  { "x-hub-signature-256": whatsappSignature }
);
assert.equal(whatsappHello.status, 200);
assert.equal(whatsappHello.data.ok, true);

// Duplicate deliveries of the same WhatsApp message id must be claimed once,
// even if Meta retries or multiple app subscriptions point at the same webhook.
const outboundAfterFirstHello = whatsappOutboundMessages;
const whatsappDuplicate = await invoke(
  agent,
  "POST",
  whatsappPayload,
  { provider: "whatsapp" },
  { "x-hub-signature-256": whatsappSignature }
);
assert.equal(whatsappDuplicate.status, 200);
assert.equal(whatsappOutboundMessages, outboundAfterFirstHello);

const whatsappStatusPayload = {
  object: "whatsapp_business_account",
  entry: [{
    id: "ci-waba",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "441234567890",
          phone_number_id: "123456789"
        },
        statuses: [{
          id: "wamid.ci",
          status: "delivered",
          timestamp: "1780000001",
          recipient_id: "447000000000",
          conversation: { id: "ci-conversation" },
          pricing: { billable: false, pricing_model: "PMP" }
        }]
      }
    }]
  }]
};
const whatsappStatusRaw = JSON.stringify(whatsappStatusPayload);
const whatsappStatusSignature = "sha256=" + crypto
  .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
  .update(Buffer.from(whatsappStatusRaw))
  .digest("hex");

const whatsappStatus = await invoke(
  agent,
  "POST",
  whatsappStatusPayload,
  { provider: "whatsapp" },
  { "x-hub-signature-256": whatsappStatusSignature }
);
assert.equal(whatsappStatus.status, 200);
const whatsappEvents = await listAuditEvents(null, 100);
assert.ok(
  whatsappEvents.some((event) =>
    event.event_type === "whatsapp_delivery_status" &&
    event.data?.whatsapp_message_id === "wamid.ci" &&
    event.data?.status === "delivered"
  )
);

// WhatsApp exact-payment review must be bound to the originating phone,
// workspace and approver role, then return a receipt to the same chat.
const waIdentity = "whatsapp:447000000000";
const waWorkspace = await getOrCreateTelegramWorkspace({
  id: waIdentity,
  first_name: "CI User"
});
const waInvoice = Buffer.from(
  "INVOICE 33J-WA-CI-1\nSupplier: WhatsApp Supplier Ltd\nAmount due: GBP 1250\nTarget: USD",
  "utf8"
).toString("base64");
const waAnalysis = await invoke(analyze, "POST", {
  fileName: "wa-ci-invoice.txt",
  mimeType: "text/plain",
  fileData: waInvoice,
  corridor: "USD"
});
assert.equal(waAnalysis.status, 200);
await assignPaymentWorkspace(waAnalysis.data.id, waWorkspace.workspace.id);

const waLaunch = signWhatsAppLaunch({
  paymentId: waAnalysis.data.id,
  whatsappUserId: "447000000000",
  workspaceId: waWorkspace.workspace.id
});
const waReview = await invoke(
  whatsappReview,
  "GET",
  undefined,
  { paymentId: waAnalysis.data.id, token: waLaunch }
);
assert.equal(waReview.status, 200);
assert.equal(waReview.data.payment.id, waAnalysis.data.id);
assert.equal(waReview.data.workspace.canApprove, true);

const badWaReview = await invoke(
  whatsappReview,
  "GET",
  undefined,
  { paymentId: waAnalysis.data.id, token: waLaunch + "tampered" }
);
assert.equal(badWaReview.status, 401);

const waApproval = await invoke(approve, "POST", {
  paymentId: waAnalysis.data.id,
  acknowledgements: {},
  amountUsdg: 1,
  channel: "whatsapp",
  whatsappLaunchToken: waLaunch
});
assert.equal(waApproval.status, 200);
assert.ok(waApproval.data.approvalToken);

const outboundBeforeSettlement = whatsappOutboundMessages;
const waSettlement = await invoke(settle, "POST", {
  approvalToken: waApproval.data.approvalToken
});
assert.equal(waSettlement.status, 200);
assert.equal(waSettlement.data.mode, "demo");
assert.equal(waSettlement.data.whatsappReceipt.sent, true);
assert.ok(whatsappOutboundMessages > outboundBeforeSettlement);

const waReplay = await invoke(settle, "POST", {
  approvalToken: waApproval.data.approvalToken
});
assert.equal(waReplay.status, 200);
assert.equal(waReplay.data.idempotent, true);
assert.equal(waReplay.data.whatsappReceipt.idempotent, true);

globalThis.fetch = whatsappOriginalFetch;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_VERIFY_TOKEN;
delete process.env.WHATSAPP_APP_SECRET;
delete process.env.WHATSAPP_GRAPH_VERSION;

process.env.TELEGRAM_BOT_TOKEN = "ci-telegram-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "ci-telegram-secret";
process.env.PUBLIC_APP_URL = "https://33jack.example";

const telegramFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const value = String(url);
  if (value.includes("/sendMessage")) {
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 1 }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (value.includes("/setChatMenuButton")) {
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return telegramFetch(url, options);
};

const blockedTelegram = await invoke(
  agent,
  "POST",
  { message: { chat: { id: 123 }, text: "/start" } },
  { provider: "telegram" },
  {}
);
assert.equal(blockedTelegram.status, 401);

const telegramStart = await invoke(
  agent,
  "POST",
  { message: { chat: { id: 123 }, text: "/start" } },
  { provider: "telegram" },
  { "x-telegram-bot-api-secret-token": "ci-telegram-secret" }
);
assert.equal(telegramStart.status, 200);
assert.equal(telegramStart.data.ok, true);

// Telegram Mini App approval identity + post-settlement receipt must be
// bound to the signed Telegram user and payment.
const telegramUser = { id: 123, first_name: "CI", username: "ci_user" };
const authDate = Math.floor(Date.now() / 1000);
const initParams = new URLSearchParams({
  auth_date: String(authDate),
  query_id: "ci-query",
  user: JSON.stringify(telegramUser)
});
const initCheck = Array.from(initParams.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => `${key}=${value}`)
  .join("\n");
const initSecret = crypto
  .createHmac("sha256", "WebAppData")
  .update(process.env.TELEGRAM_BOT_TOKEN)
  .digest();
const initHash = crypto
  .createHmac("sha256", initSecret)
  .update(initCheck)
  .digest("hex");
initParams.set("hash", initHash);
const telegramInitData = initParams.toString();
const telegramLaunchToken = signTelegramLaunch({
  paymentId: first.data.id,
  userId: telegramUser.id
});

const telegramReceipt = await invoke(
  agent,
  "POST",
  {
    action: "receipt",
    paymentId: first.data.id,
    telegramInitData,
    telegramLaunchToken
  },
  { provider: "telegram-miniapp" }
);
assert.equal(telegramReceipt.status, 200);
assert.equal(telegramReceipt.data.ok, true);
assert.equal(telegramReceipt.data.idempotent, false);

const telegramReceiptReplay = await invoke(
  agent,
  "POST",
  {
    action: "receipt",
    paymentId: first.data.id,
    telegramInitData,
    telegramLaunchToken
  },
  { provider: "telegram-miniapp" }
);
assert.equal(telegramReceiptReplay.status, 200);
assert.equal(telegramReceiptReplay.data.idempotent, true);

const telegramDashboard = await invoke(
  agent,
  "POST",
  {
    action: "dashboard",
    telegramInitData
  },
  { provider: "telegram-miniapp" }
);
assert.equal(telegramDashboard.status, 200);
assert.equal(telegramDashboard.data.ok, true);
assert.equal(String(telegramDashboard.data.user.id), "123");
assert.ok(telegramDashboard.data.payments.some((p) => p.id === first.data.id));
assert.ok(telegramDashboard.data.history.some((e) => e.payment_id === first.data.id));

globalThis.fetch = telegramFetch;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_WEBHOOK_SECRET;
delete process.env.PUBLIC_APP_URL;

const status = await invoke(health, "GET");
assert.equal(status.status, 200);
assert.equal(status.data.ok, true);
assert.equal(status.data.checks.secureApprovals, true);
assert.equal(status.data.channels.whatsapp.configured, false);
assert.equal(status.data.channels.telegram.configured, false);

console.log("33jack smoke: invoice settlement + Wise reconciliation + WhatsApp + Telegram channels PASS");
