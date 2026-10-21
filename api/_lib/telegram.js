import crypto from "node:crypto";
import {
  addAuditEvent,
  assignPaymentWorkspace,
  createWorkspaceInvite,
  getBeneficiaryControl,
  getOrCreateTelegramWorkspace,
  getPayment,
  getTelegramPreferences,
  getTelegramWorkspaceMembership,
  joinWorkspaceInvite,
  listAuditEvents,
  listBeneficiaries,
  listBeneficiaryControls,
  listPayments,
  listPaymentsByWorkspace,
  listWorkspaceMembers,
  roleCan,
  setBeneficiaryControl,
  setWorkspaceMemberRole,
  updateTelegramPreferences
} from "./db.js";
import { getPayout, listPayoutsByWorkspace, savePayout } from "./payout-store.js";
import { getExternalPayoutStatus } from "./payout-provider.js";
import { getPolicyConfig } from "./policy.js";
import {
  signTelegramLaunch,
  verifyTelegramApproval,
  verifyTelegramInitData
} from "./telegram-auth.js";

const MAX_INVOICE_BYTES = Math.floor(3.2 * 1024 * 1024);

function botToken() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

function appBaseUrl(req) {
  const explicit = String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const host =
    req?.headers?.["x-forwarded-host"] ||
    req?.headers?.host ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "";
  return host ? `https://${String(host).replace(/^https?:\/\//, "").replace(/\/$/, "")}` : "";
}

function allowedChat(chatId) {
  const configured = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configured.length) return true;
  return configured.includes(String(chatId));
}

export function telegramReadiness() {
  return {
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    webhookSecretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    chatAllowlistConfigured: Boolean(
      String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").trim()
    )
  };
}

export function verifyTelegramWebhook(req) {
  const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const isProduction =
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production";

  if (!expected) return !isProduction;

  const actual = String(
    req?.headers?.["x-telegram-bot-api-secret-token"] || ""
  );
  if (!actual) return false;

  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function telegramApi(method, payload = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken()}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(
      data?.description || `Telegram ${method} failed with HTTP ${response.status}`
    );
  }
  return data?.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
    ...extra
  });
}

function compactStatus(payments = []) {
  const active = payments.filter((p) =>
    ["analyzed", "approved", "settling", "failed"].includes(String(p.status || ""))
  );
  const settled = payments.filter((p) =>
    ["settled_demo", "settled_devnet", "settled_celo"].includes(String(p.status || ""))
  );
  const flagged = payments.filter((p) =>
    p.risk?.duplicate ||
    p.risk?.beneficiary_changed ||
    p.risk?.suspicious ||
    (Array.isArray(p.risk?.missing_fields) && p.risk.missing_fields.length)
  );
  return { active, settled, flagged };
}

function riskFlags(risk = {}) {
  const flags = [];
  if (risk.duplicate) flags.push("duplicate");
  if (risk.beneficiary_changed) flags.push("beneficiary changed");
  if (risk.suspicious) flags.push("suspicious");
  if (Array.isArray(risk.missing_fields) && risk.missing_fields.length) {
    flags.push(`missing: ${risk.missing_fields.join(", ")}`);
  }
  return flags;
}

async function getTelegramFile(message) {
  const document = message?.document || null;
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  const photo = photos.length ? photos[photos.length - 1] : null;
  const file = document || photo;
  if (!file?.file_id) return null;

  if (Number(file.file_size || 0) > MAX_INVOICE_BYTES) {
    throw new Error("Invoice is over the 3.2 MB 33Jack demo limit");
  }

  const meta = await telegramApi("getFile", { file_id: file.file_id });
  if (!meta?.file_path) throw new Error("Telegram did not return a file path");

  const response = await fetch(
    `https://api.telegram.org/file/bot${botToken()}/${meta.file_path}`
  );
  if (!response.ok) {
    throw new Error(`Could not download Telegram file (HTTP ${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_INVOICE_BYTES) {
    throw new Error("Invoice is over the 3.2 MB 33Jack demo limit");
  }

  const fileName =
    document?.file_name ||
    (photo ? `telegram_invoice_${message.message_id || Date.now()}.jpg` : "telegram_invoice.bin");
  const mimeType =
    document?.mime_type ||
    (photo ? "image/jpeg" : "application/octet-stream");

  return {
    fileName,
    mimeType,
    fileData: bytes.toString("base64")
  };
}

async function analyzeTelegramInvoice(req, message, corridor = "USD") {
  const file = await getTelegramFile(message);
  if (!file) return null;

  const base = appBaseUrl(req);
  if (!base) throw new Error("PUBLIC_APP_URL is not configured");

  const response = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...file, corridor })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || "Invoice analysis failed");
  }
  return data;
}

function invoiceSummary(analysis = {}) {
  const flags = riskFlags(analysis.risk);
  const amount =
    analysis.source_amount && analysis.source_currency
      ? `${analysis.source_currency} ${Number(analysis.source_amount).toLocaleString()}`
      : "Not extracted";
  return [
    "33Jack invoice review",
    "",
    `Supplier: ${analysis.supplier || "Not extracted"}`,
    `Invoice: ${analysis.invoice_number || analysis.invoice_name || analysis.id || "—"}`,
    `Amount: ${amount}`,
    `Target: ${analysis.destination_currency || "—"}`,
    `Route: ${analysis.recommended_route || "Pending"}`,
    `Risk: ${flags.length ? flags.join("; ") : "No active deterministic flags"}`,
    "",
    "AI prepared the instruction. Exact approval and money movement stay inside the controlled 33Jack approval flow."
  ].join("\n");
}


function dashboardUrl(base) {
  return base ? `${base}/telegram-dashboard.html` : "";
}

async function ensureTelegramMenuButton(base) {
  const url = dashboardUrl(base);
  if (!url) return false;
  try {
    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Open 33Jack",
        web_app: { url }
      }
    });
    return true;
  } catch {
    return false;
  }
}

function telegramUserIdFromEvent(event) {
  const fromData = event?.data?.telegram_user_id;
  if (fromData != null) return String(fromData);
  const actor = String(event?.actor || "");
  const match = actor.match(/^telegram-user:(.+)$/);
  return match?.[1] || "";
}

async function telegramScopedData(user, limit = 100) {
  const context = await getOrCreateTelegramWorkspace(user);
  const uid = String(user.id);
  const allEvents = await listAuditEvents(null, 500);

  // Adopt legacy Telegram-linked payments into the user workspace once.
  const legacyIds = Array.from(new Set(
    allEvents
      .filter((event) => telegramUserIdFromEvent(event) === uid)
      .map((event) => String(event.payment_id || ""))
      .filter(Boolean)
  ));
  for (const id of legacyIds) {
    try {
      const payment = await getPayment(id);
      if (payment && !payment.workspace_id) {
        await assignPaymentWorkspace(id, context.workspace.id);
      }
    } catch {
      // Legacy payout ids can also appear in jack_events; ignore non-payment ids.
    }
  }

  const [payments, payouts] = await Promise.all([
    listPaymentsByWorkspace(context.workspace.id, limit),
    listPayoutsByWorkspace(context.workspace.id, limit)
  ]);
  const recordIds = new Set([
    ...payments.map((p) => String(p.id)),
    ...payouts.map((p) => String(p.id))
  ]);
  const events = allEvents
    .filter((event) =>
      recordIds.has(String(event.payment_id || "")) ||
      String(event.data?.workspace_id || "") === String(context.workspace.id)
    )
    .slice(0, 150);

  return { context, payments, payouts, events };
}

function dashboardPayment(payment, userId, base, role) {
  const missing = Array.isArray(payment.risk?.missing_fields) ? payment.risk.missing_fields : [];
  const reviewable =
    roleCan(role, "approve") &&
    ["analyzed", "failed"].includes(String(payment.status || "")) &&
    missing.length === 0;
  const launchToken = reviewable ? signTelegramLaunch({ paymentId: payment.id, userId }) : null;
  return {
    id: payment.id,
    supplier: payment.supplier || null,
    invoice: payment.invoice_number || payment.invoice_name || payment.id,
    invoice_name: payment.invoice_name || null,
    source_currency: payment.source_currency || null,
    source_amount: payment.source_amount == null ? null : Number(payment.source_amount),
    destination_currency: payment.destination_currency || null,
    destination_amount: payment.destination_amount || null,
    route: payment.route || null,
    status: payment.status || null,
    created_at: payment.created_at || null,
    updated_at: payment.updated_at || null,
    beneficiary: {
      name: payment.beneficiary?.name || null,
      bank_name: payment.beneficiary?.bank_name || null,
      account_last4: payment.beneficiary?.account_last4 || null,
      country: payment.beneficiary?.country || null
    },
    risk: {
      duplicate: Boolean(payment.risk?.duplicate),
      beneficiary_changed: Boolean(payment.risk?.beneficiary_changed),
      suspicious: Boolean(payment.risk?.suspicious),
      missing_fields: missing
    },
    settlement: {
      amount_usdg: payment.approval?.amount_usdg == null ? null : Number(payment.approval.amount_usdg),
      signature: payment.settlement_signature || null,
      explorer: payment.status === "settled_devnet" && payment.settlement_signature
        ? `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`
        : payment.status === "settled_celo" && payment.settlement_signature
          ? `https://celoscan.io/tx/${payment.settlement_signature}`
          : null
    },
    can_create_fiat_payout:
      roleCan(role, "operate") &&
      ["USDG", "USDC", "USDT"].includes(String(payment.source_currency || "").toUpperCase()) &&
      ["USD", "GBP", "CNY", "INR"].includes(String(payment.destination_currency || "").toUpperCase()),
    review_url: base && launchToken
      ? `${base}/telegram.html?payment=${encodeURIComponent(payment.id)}&launch=${encodeURIComponent(launchToken)}`
      : null,
    celo_url: base && launchToken
      ? `${base}/app/celo?channel=telegram&paymentId=${encodeURIComponent(payment.id)}&telegramLaunchToken=${encodeURIComponent(launchToken)}`
      : null
  };
}

function dashboardPayout(payout, role) {
  return {
    id: payout.id,
    invoice_ref: payout.invoice_ref || null,
    funding_asset: payout.funding_asset || null,
    funding_amount: Number(payout.funding_amount || 0),
    destination_currency: payout.destination_currency || null,
    destination_amount: Number(payout.destination_amount || 0),
    exchange_rate: Number(payout.exchange_rate || 0),
    fee_amount: Number(payout.fee_amount || 0),
    status: payout.status || null,
    receipt_id: payout.receipt_id || null,
    created_at: payout.created_at || null,
    updated_at: payout.updated_at || null,
    beneficiary: payout.beneficiary || {},
    provider: payout.quote?.provider || "internal_sandbox",
    provider_status: payout.quote?.providerStatus || null,
    provider_status_label: payout.quote?.providerStatusLabel || null,
    provider_transfer_id: payout.quote?.providerTransferId || null,
    quote_expires_at: payout.quote?.expiresAt || null,
    can_approve: roleCan(role, "approve") && payout.status === "quoted",
    can_track: String(payout.quote?.provider || "") === "wise_sandbox" && Boolean(payout.quote?.providerTransferId)
  };
}

function dashboardEvent(event) {
  return {
    id: event.id || null,
    payment_id: event.payment_id || null,
    event_type: event.event_type || null,
    actor: event.actor || null,
    created_at: event.created_at || null,
    data: {
      from: event.data?.from || null,
      to: event.data?.to || null,
      mode: event.data?.mode || null,
      route: event.data?.route || null,
      provider: event.data?.provider || null,
      provider_status: event.data?.provider_status || null,
      amount_usdg: event.data?.amount_usdg == null ? null : Number(event.data.amount_usdg),
      signature: event.data?.signature || null
    }
  };
}

function beneficiaryKey(name, currency) {
  return `${String(name || "").trim().toLowerCase().replace(/\s+/g, " ")}|${String(currency || "").toUpperCase()}`;
}

export async function handleTelegramDashboard(req, res) {
  try {
    const auth = verifyTelegramInitData(req.body?.telegramInitData, 3600);
    if (!allowedChat(auth.user.id)) {
      return res.status(403).json({ error: "This Telegram account is not allowed to open 33Jack." });
    }

    const base = appBaseUrl(req);
    const scoped = await telegramScopedData(auth.user, 100);
    const role = scoped.context.member.role;
    const payments = scoped.payments.map((payment) => dashboardPayment(payment, auth.user.id, base, role));
    const payouts = scoped.payouts.map((payout) => dashboardPayout(payout, role));
    const { active, settled, flagged } = compactStatus(scoped.payments);
    const invoices = payments.filter((payment) => Boolean(payment.invoice));
    const [members, preferences, controls, allBeneficiaries] = await Promise.all([
      listWorkspaceMembers(scoped.context.workspace.id),
      getTelegramPreferences(scoped.context.workspace.id, auth.user.id),
      listBeneficiaryControls(scoped.context.workspace.id),
      listBeneficiaries(200)
    ]);

    const supplierKeys = new Set([
      ...scoped.payments.map((p) => beneficiaryKey(p.supplier, p.destination_currency)),
      ...scoped.payouts.map((p) => beneficiaryKey(p.beneficiary?.name, p.destination_currency))
    ]);
    const controlMap = new Map(controls.map((row) => [beneficiaryKey(row.supplier_key, row.destination_currency), row]));
    const beneficiaries = allBeneficiaries
      .filter((b) => supplierKeys.has(beneficiaryKey(b.supplier_name, b.destination_currency)))
      .map((b) => ({
        ...b,
        control: controlMap.get(beneficiaryKey(b.supplier_name, b.destination_currency)) || null
      }));

    const policy = getPolicyConfig();
    return res.status(200).json({
      ok: true,
      user: {
        id: String(auth.user.id),
        first_name: auth.user.first_name || "",
        last_name: auth.user.last_name || "",
        username: auth.user.username || ""
      },
      workspace: {
        id: scoped.context.workspace.id,
        name: scoped.context.workspace.name,
        role,
        kyb_status: scoped.context.workspace.kyb_status || "not_configured",
        permissions: {
          operate: roleCan(role, "operate"),
          approve: roleCan(role, "approve"),
          manage_team: roleCan(role, "manage_team"),
          manage_beneficiaries: roleCan(role, "manage_beneficiaries")
        }
      },
      summary: {
        payments: payments.length,
        active: active.length,
        settled: settled.length,
        risk_review: flagged.length,
        invoices: invoices.length,
        payouts: payouts.length
      },
      payments,
      invoices,
      payouts,
      beneficiaries,
      team: members,
      preferences,
      compliance: {
        production_money_movement: false,
        kyb_status: scoped.context.workspace.kyb_status || policy.kybStatus || "not_configured",
        allowed_currencies: policy.allowedCurrencies,
        single_limit_usd: policy.singleLimitUsd,
        kyb_required: policy.kybRequired,
        blocked_countries_configured: policy.blockedCountries.length > 0
      },
      history: scoped.events.map(dashboardEvent)
    });
  } catch (error) {
    return res.status(401).json({
      error: "Telegram dashboard authentication failed",
      detail: error?.message || "Unknown Telegram dashboard error"
    });
  }
}
export async function sendTelegramPaymentReceipt({ payment, userId, base = "" }) {
  if (!payment?.id) throw new Error("Payment is required for Telegram receipt");
  if (!userId) throw new Error("Telegram user is required for receipt");

  const membership = await getTelegramWorkspaceMembership(userId);
  if (membership) {
    const preferences = await getTelegramPreferences(membership.workspace.id, userId);
    if (preferences.receipt_messages === false) {
      return { ok: true, idempotent: false, suppressed: true };
    }
  }

  if (!["settled_demo", "settled_devnet", "settled_celo"].includes(String(payment.status || ""))) {
    throw new Error(`Payment is not settled yet (current status: ${payment.status || "unknown"})`);
  }

  const existingEvents = await listAuditEvents(payment.id, 100);
  const alreadySent = existingEvents.some((event) =>
    event.event_type === "telegram_receipt_sent" &&
    String(event.data?.telegram_user_id || "") === String(userId)
  );

  if (alreadySent) {
    return { ok: true, idempotent: true };
  }

  const settlementAmount = Number(payment.approval?.amount_usdg || 0);
  const statusLabel = payment.status === "settled_celo" ? "Settled on Celo Mainnet" :
    payment.status === "settled_devnet" ? "Settled on Solana Devnet" : "Settled in controlled demo";
  const invoiceAmount = payment.source_amount && payment.source_currency
    ? `${payment.source_currency} ${Number(payment.source_amount).toLocaleString()}`
    : "—";

  const lines = [
    "33Jack payment complete",
    "",
    `Supplier: ${payment.supplier || "—"}`,
    `Invoice: ${payment.invoice_number || payment.invoice_name || payment.id}`,
    `Invoice amount: ${invoiceAmount}`,
    payment.approval?.celo ? `Celo settlement: ${payment.approval.celo.amount} ${payment.approval.celo.token}` :
      settlementAmount > 0 ? `Settlement amount: ${settlementAmount} USDG` : null,
    `Destination: ${payment.destination_amount || payment.destination_currency || "—"}`,
    `Status: ${statusLabel}`,
    "Reconciled: ✓",
    payment.settlement_signature ? `Reference: ${payment.settlement_signature}` : null
  ].filter(Boolean);

  const buttons = [];
  if (payment.status === "settled_devnet" && payment.settlement_signature) {
    buttons.push([{
      text: "View Solana transaction",
      url: `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`
    }]);
  }
  if (payment.status === "settled_celo" && payment.settlement_signature) {
    buttons.push([{ text: "View Celo transaction", url: `https://celoscan.io/tx/${payment.settlement_signature}` }]);
  }
  if (base) {
    buttons.push([{ text: "Open 33Jack", web_app: { url: dashboardUrl(base) } }]);
  }

  await sendMessage(
    userId,
    lines.join("\n"),
    buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}
  );

  await addAuditEvent(payment.id, "telegram_receipt_sent", `telegram-user:${userId}`, {
    telegram_user_id: String(userId),
    status: payment.status,
    settlement_signature: payment.settlement_signature || null
  });

  return { ok: true, idempotent: false };
}

export async function handleTelegramMiniAppAction(req, res) {
  const body = req.body || {};
  const action = String(body.action || "").toLowerCase();

  if (action === "dashboard") {
    return handleTelegramDashboard(req, res);
  }

  if (["preferences_update", "invite_create", "invite_join", "member_role", "beneficiary_control", "payout_track"].includes(action)) {
    try {
      const auth = verifyTelegramInitData(body.telegramInitData, 3600);
      if (!allowedChat(auth.user.id)) {
        return res.status(403).json({ error: "This Telegram account is not allowed to use 33Jack." });
      }

      if (action === "invite_join") {
        const joined = await joinWorkspaceInvite(auth.user, body.code);
        await addAuditEvent(null, "workspace_member_joined", `telegram-user:${auth.user.id}`, {
          workspace_id: joined.workspace.id,
          role: joined.member.role,
          telegram_user_id: String(auth.user.id)
        });
        return res.status(200).json({ ok: true, workspace: joined.workspace, member: joined.member });
      }

      const context = await getOrCreateTelegramWorkspace(auth.user);

      if (action === "preferences_update") {
        const preferences = await updateTelegramPreferences(
          context.workspace.id,
          auth.user.id,
          body.preferences || {}
        );
        return res.status(200).json({ ok: true, preferences });
      }

      if (action === "invite_create") {
        if (!roleCan(context.member.role, "manage_team")) {
          return res.status(403).json({ error: "Your workspace role cannot invite team members" });
        }
        const invite = await createWorkspaceInvite(
          context.workspace.id,
          auth.user.id,
          body.role || "viewer",
          body.ttlMinutes || 1440
        );
        return res.status(200).json({ ok: true, invite });
      }

      if (action === "member_role") {
        if (!roleCan(context.member.role, "manage_team")) {
          return res.status(403).json({ error: "Your workspace role cannot manage team roles" });
        }
        if (String(body.telegramUserId || "") === String(auth.user.id)) {
          return res.status(400).json({ error: "You cannot change your own role here" });
        }
        const member = await setWorkspaceMemberRole(
          context.workspace.id,
          body.telegramUserId,
          body.role
        );
        await addAuditEvent(null, "workspace_member_role_changed", `telegram-user:${auth.user.id}`, {
          workspace_id: context.workspace.id,
          target_telegram_user_id: String(body.telegramUserId),
          role: member.role
        });
        return res.status(200).json({ ok: true, member });
      }

      if (action === "beneficiary_control") {
        if (!roleCan(context.member.role, "manage_beneficiaries")) {
          return res.status(403).json({ error: "Your workspace role cannot manage beneficiaries" });
        }
        const control = await setBeneficiaryControl(
          context.workspace.id,
          body.supplier,
          body.destinationCurrency,
          body.status,
          body.note,
          auth.user.id
        );
        await addAuditEvent(null, "beneficiary_control_changed", `telegram-user:${auth.user.id}`, {
          workspace_id: context.workspace.id,
          supplier: body.supplier,
          destination_currency: body.destinationCurrency,
          status: control.status
        });
        return res.status(200).json({ ok: true, control });
      }

      if (action === "payout_track") {
        const payout = await getPayout(body.payoutId);
        if (!payout || String(payout.workspace_id || "") !== String(context.workspace.id)) {
          return res.status(404).json({ error: "Payout not found in this workspace" });
        }
        if (String(payout.quote?.provider || "") !== "wise_sandbox") {
          return res.status(200).json({ ok: true, payout: dashboardPayout(payout, context.member.role), tracking: null });
        }
        const tracking = await getExternalPayoutStatus(payout);
        const updated = await savePayout({
          ...payout,
          status: tracking.localStatus,
          quote: {
            ...payout.quote,
            providerStatus: tracking.providerStatus,
            providerStatusLabel: tracking.friendlyStatus,
            providerStatusCheckedAt: new Date().toISOString()
          }
        });
        if (String(payout.quote?.providerStatus || "") !== String(tracking.providerStatus || "")) {
          await addAuditEvent(payout.id, "fiat_payout_provider_status", `telegram-user:${auth.user.id}`, {
            workspace_id: context.workspace.id,
            provider: "wise_sandbox",
            transfer_id: tracking.transferId,
            previous_status: payout.quote?.providerStatus || null,
            provider_status: tracking.providerStatus,
            local_status: tracking.localStatus
          });
        }
        return res.status(200).json({
          ok: true,
          payout: dashboardPayout(updated, context.member.role),
          tracking: {
            provider_status: tracking.providerStatus,
            friendly_status: tracking.friendlyStatus,
            reconciled: tracking.reconciled,
            final: tracking.final
          }
        });
      }
    } catch (error) {
      return res.status(400).json({
        error: "Telegram workspace action failed",
        detail: error?.message || "Unknown Telegram workspace error"
      });
    }
  }

  if (action !== "receipt") {
    return res.status(400).json({ error: "Unsupported Telegram Mini App action" });
  }

  try {
    const paymentId = String(body.paymentId || "").trim();
    if (!paymentId) return res.status(400).json({ error: "paymentId is required" });

    const auth = verifyTelegramApproval({
      initData: body.telegramInitData,
      launchToken: body.telegramLaunchToken,
      paymentId
    });

    const payment = await getPayment(paymentId);
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    if (!["settled_demo", "settled_devnet", "settled_celo"].includes(String(payment.status || ""))) {
      return res.status(409).json({
        error: "Payment is not settled yet",
        detail: `Current status is ${payment.status || "unknown"}`
      });
    }

    const result = await sendTelegramPaymentReceipt({
      payment,
      userId: auth.user.id,
      base: appBaseUrl(req)
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      error: "Telegram receipt rejected",
      detail: error?.message || "Unknown Telegram receipt error"
    });
  }
}

export async function handleTelegramWebhook(req, res) {
  if (!verifyTelegramWebhook(req)) {
    return res.status(401).json({ error: "Invalid Telegram webhook secret" });
  }

  const update = req.body || {};
  const message = update.message || update.edited_message || null;
  if (!message?.chat?.id) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const chatId = message.chat.id;
  if (!allowedChat(chatId)) {
    await sendMessage(chatId, "This 33Jack Telegram demo is restricted to approved test chats.");
    return res.status(200).json({ ok: true, restricted: true });
  }

  try {
    const text = String(message.text || message.caption || "").trim();
    const base = appBaseUrl(req);

    if (/^\/start\b/i.test(text)) {
      await ensureTelegramMenuButton(base);
      await sendMessage(
        chatId,
        [
          "33Jack Telegram",
          "",
          "Send me an invoice as PDF, PNG, JPG, WEBP or TXT and I’ll prepare the payment review.",
          "",
          "Commands:",
          "/status — current 33Jack payment state",
          "/help — how this demo works",
          "",
          "Money movement still requires the exact human approval flow in 33Jack."
        ].join("\n"),
        base
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "Open 33Jack", web_app: { url: dashboardUrl(base) } }]]
              }
            }
          : {}
      );
      return res.status(200).json({ ok: true });
    }

    if (/^\/help\b/i.test(text)) {
      await sendMessage(
        chatId,
        "Upload an invoice. 33Jack extracts the instruction, checks duplicate / beneficiary / suspicious signals, then opens Review & Pay inside Telegram. Use Open 33Jack for your payments, invoices and history."
      );
      return res.status(200).json({ ok: true });
    }

    if (/^\/status\b/i.test(text)) {
      const telegramUser = message?.from || { id: chatId };
      const telegramUserId = telegramUser.id || chatId;
      const scoped = await telegramScopedData(telegramUser, 100);
      const payments = scoped.payments;
      const { active, settled, flagged } = compactStatus(payments);
      await sendMessage(
        chatId,
        [
          "33Jack status",
          "",
          `Stored payments: ${payments.length}`,
          `Active / pending: ${active.length}`,
          `Settled: ${settled.length}`,
          `Risk review: ${flagged.length}`
        ].join("\n"),
        base
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "Open dashboard", web_app: { url: dashboardUrl(base) } }]]
              }
            }
          : {}
      );
      return res.status(200).json({ ok: true });
    }

    if (message.document || message.photo) {
      await sendMessage(chatId, "Invoice received. 33Jack is extracting and checking it…");
      const corridorMatch = text.match(/\b(USD|GBP|CNY|INR)\b/i);
      const analysis = await analyzeTelegramInvoice(
        req,
        message,
        corridorMatch?.[1]?.toUpperCase() || "USD"
      );
      const telegramUser = message?.from || { id: chatId };
      const telegramUserId = telegramUser.id || chatId;
      const workspaceContext = await getOrCreateTelegramWorkspace(telegramUser);
      if (analysis?.id) {
        await assignPaymentWorkspace(analysis.id, workspaceContext.workspace.id);
        await addAuditEvent(analysis.id, "telegram_invoice_received", `telegram-user:${telegramUserId}`, {
          telegram_user_id: String(telegramUserId),
          chat_id: String(chatId),
          workspace_id: workspaceContext.workspace.id,
          invoice_name: analysis.invoice_name || null
        });
      }
      const launchToken = analysis?.id
        ? signTelegramLaunch({ paymentId: analysis.id, userId: telegramUserId })
        : null;
      const miniAppUrl = base && analysis?.id && launchToken
        ? `${base}/telegram.html?payment=${encodeURIComponent(analysis.id)}&launch=${encodeURIComponent(launchToken)}`
        : base;
      await sendMessage(
        chatId,
        invoiceSummary(analysis),
        base
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "Review & Pay", web_app: { url: miniAppUrl } }],
                  [{ text: "Review on Celo Mainnet", web_app: { url: `${base}/app/celo?channel=telegram&paymentId=${encodeURIComponent(analysis.id)}&telegramLaunchToken=${encodeURIComponent(launchToken)}` } }]]
              }
            }
          : {}
      );
      return res.status(200).json({
        ok: true,
        paymentId: analysis?.id || null
      });
    }

    const telegramUser = message?.from || { id: chatId };
    const telegramUserId = telegramUser.id || chatId;
    const scoped = await telegramScopedData(telegramUser, 100);
    const { active, flagged } = compactStatus(scoped.payments);
    await sendMessage(
      chatId,
      `33Jack is connected. I can receive invoices here and prepare them for review. Right now there are ${active.length} active payment(s) and ${flagged.length} requiring risk review. Use /status or upload an invoice.`,
      base
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: "Open 33Jack", web_app: { url: dashboardUrl(base) } }]]
            }
          }
        : {}
    );
    return res.status(200).json({ ok: true });
  } catch (error) {
    await sendMessage(
      chatId,
      `33Jack could not process that request: ${error?.message || "Unknown error"}`
    ).catch(() => {});
    return res.status(200).json({
      ok: false,
      detail: error?.message || "Unknown error"
    });
  }
}
