import { createHash } from "node:crypto";
import { verifyTelegramApproval } from "./telegram-auth.js";
import { verifyWhatsAppLaunch } from "./whatsapp-auth.js";
import { verifyWeChatLaunch } from "./wechat-auth.js";
import { getPayment, getOrCreateTelegramWorkspace, getTelegramWorkspaceMembership, roleCan } from "./db.js";

function checkedChannel(body) {
  const channel = String(body.channel || "").toLowerCase();
  if (!["telegram", "whatsapp", "wechat"].includes(channel)) throw Object.assign(new Error("Unsupported channel"), { status: 400 });
  return channel;
}

export function invoiceChannelAgentId(workspaceId) {
  return "channel_" + createHash("sha256").update(String(workspaceId)).digest("hex").slice(0, 48);
}

export function assertInvoiceEligibility(payment, acknowledgements = {}) {
  if (!payment || !["analyzed", "failed"].includes(String(payment.status || ""))) {
    throw Object.assign(new Error("Invoice is not eligible for a new Celo payment"), { status: 409 });
  }
  const risk = payment.risk || {};
  const missing = Array.isArray(risk.missing_fields) ? risk.missing_fields.filter(Boolean) : [];
  if (missing.length) throw Object.assign(new Error("Resolve missing invoice fields before paying: " + missing.join(", ")), { status: 409 });
  const flags = ["duplicate", "beneficiary_changed", "suspicious"].filter(x => risk[x] === true);
  const incomplete = flags.filter(x => acknowledgements[x] !== true);
  if (incomplete.length) throw Object.assign(new Error("Explicit risk acknowledgement required: " + incomplete.join(", ")), { status: 409 });
  return { flags, acknowledgements: Object.fromEntries(flags.map(x => [x, true])) };
}

export async function authorizeChannelInvoice(body = {}, capability = "view") {
  const channel = checkedChannel(body);
  const paymentId = String(body.paymentId || "").trim();
  if (!paymentId || paymentId.length > 150) throw Object.assign(new Error("Valid paymentId is required"), { status: 400 });
  let context;
  let identity;
  if (channel === "telegram") {
    const proof = verifyTelegramApproval({
      initData: body.telegramInitData,
      launchToken: body.telegramLaunchToken,
      paymentId
    });
    const allowed = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(proof.user.id))) throw Object.assign(new Error("Telegram user not allowed"), { status: 403 });
    context = await getOrCreateTelegramWorkspace(proof.user);
    identity = "telegram:" + proof.user.id;
  } else if (channel === "whatsapp") {
    if (!process.env.WHATSAPP_APP_SECRET && !process.env.APPROVAL_HMAC_SECRET) {
      throw Object.assign(new Error("WhatsApp signed review is not configured"), { status: 503 });
    }
    const proof = verifyWhatsAppLaunch(body.token, paymentId);
    identity = "whatsapp:" + proof.whatsappUserId;
    context = await getTelegramWorkspaceMembership(identity);
    if (!context || String(context.workspace.id) !== String(proof.workspaceId)) throw Object.assign(new Error("Workspace mismatch"), { status: 403 });
  } else {
    if (!process.env.WECHAT_REVIEW_SECRET && !process.env.APPROVAL_HMAC_SECRET && !process.env.WECHAT_TOKEN) {
      throw Object.assign(new Error("WeChat signed review is not configured"), { status: 503 });
    }
    const proof = verifyWeChatLaunch(body.token, paymentId);
    identity = "wechat:" + proof.wechatOpenId;
    context = await getTelegramWorkspaceMembership(identity);
    if (!context || String(context.workspace.id) !== String(proof.workspaceId)) throw Object.assign(new Error("Workspace mismatch"), { status: 403 });
  }
  if (!context?.member || !roleCan(context.member.role, capability)) {
    throw Object.assign(new Error("You do not have permission to " + capability + " this payment"), { status: 403 });
  }
  const payment = await getPayment(paymentId);
  if (!payment || !payment.workspace_id || String(payment.workspace_id) !== String(context.workspace.id)) {
    throw Object.assign(new Error("Invoice is not available in your workspace"), { status: 404 });
  }
  return {
    channel,
    identity,
    workspaceId: String(context.workspace.id),
    role: String(context.member.role),
    actorId: invoiceChannelAgentId(context.workspace.id),
    payment
  };
}

export function safeInvoiceSummary(payment, role) {
  const risk = payment.risk || {};
  return {
    id: payment.id, invoice: payment.invoice_number || payment.invoice_name || payment.id,
    supplier: payment.supplier || null, status: payment.status,
    originalCurrency: payment.source_currency || null,
    originalAmount: payment.source_amount == null ? null : String(payment.source_amount),
    risk: {
      duplicate: Boolean(risk.duplicate), beneficiary_changed: Boolean(risk.beneficiary_changed),
      suspicious: Boolean(risk.suspicious),
      missing_fields: Array.isArray(risk.missing_fields) ? risk.missing_fields : []
    },
    role, canPropose: roleCan(role,"operate"), canApprove: roleCan(role,"approve")
  };
}
