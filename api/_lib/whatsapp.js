import crypto from "node:crypto";
import OpenAI from "openai";
import {
  addAuditEvent,
  assignPaymentWorkspace,
  claimChannelMessage,
  createWorkspaceInvite,
  getOrCreateTelegramWorkspace,
  getPayment,
  getTelegramPreferences,
  getTelegramWorkspaceMembership,
  joinWorkspaceInvite,
  listAuditEvents,
  listBeneficiaries,
  listPaymentsByWorkspace,
  listWorkspaceMembers,
  roleCan,
  setBeneficiaryControl,
  setWorkspaceMemberRole,
  updateTelegramPreferences
} from "./db.js";
import { getPayout, listPayoutsByWorkspace, savePayout } from "./payout-store.js";
import { getExternalPayoutStatus } from "./payout-provider.js";
import { signWhatsAppLaunch } from "./whatsapp-auth.js";

const MAX_INVOICE_BYTES = Math.floor(3.2 * 1024 * 1024);
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const WHATSAPP_AGENT_MODEL = () =>
  String(process.env.GROQ_AGENT_MODEL || "openai/gpt-oss-20b").trim();
const WHATSAPP_TRANSCRIPTION_MODEL = () =>
  String(process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo").trim();

function graphVersion() {
  return String(process.env.WHATSAPP_GRAPH_VERSION || "v25.0").trim();
}

function normalizeWhatsAppRecipient(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

class WhatsAppGraphError extends Error {
  constructor(data = {}, status = 0) {
    const meta = data?.error || {};
    super(
      meta?.message ||
      data?.message ||
      data?.raw ||
      `WhatsApp Graph API HTTP ${status || "unknown"}`
    );
    this.name = "WhatsAppGraphError";
    this.status = status || 0;
    this.code = meta?.code ?? null;
    this.subcode = meta?.error_subcode ?? null;
    this.type = meta?.type || null;
    this.details = meta?.error_data?.details || null;
    this.fbtraceId = meta?.fbtrace_id || null;
  }
}

function accessToken() {
  const token = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is not configured");
  return token;
}

function phoneNumberId() {
  const id = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  if (!id) throw new Error("WHATSAPP_PHONE_NUMBER_ID is not configured");
  return id;
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

export function whatsappReadiness() {
  const cloudApiConfigured = Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
  const verifyTokenConfigured = Boolean(process.env.WHATSAPP_VERIFY_TOKEN);
  const appSecretConfigured = Boolean(process.env.WHATSAPP_APP_SECRET);
  return {
    configured: cloudApiConfigured,
    fullyConfigured:
      cloudApiConfigured &&
      verifyTokenConfigured &&
      appSecretConfigured,
    verifyTokenConfigured,
    appSecretConfigured,
    agentConfigured: Boolean(process.env.GROQ_API_KEY),
    voiceTranscriptionConfigured: Boolean(process.env.GROQ_API_KEY),
    agentModel: WHATSAPP_AGENT_MODEL(),
    transcriptionModel: WHATSAPP_TRANSCRIPTION_MODEL(),
    graphVersion: graphVersion()
  };
}

export function verifyWhatsAppChallenge(req) {
  const mode = String(req?.query?.["hub.mode"] || "");
  const token = String(req?.query?.["hub.verify_token"] || "");
  const challenge = String(req?.query?.["hub.challenge"] || "");
  const expected = String(process.env.WHATSAPP_VERIFY_TOKEN || "").trim();

  if (!expected) return { ok: false, challenge: null };
  return {
    ok: mode === "subscribe" && token === expected,
    challenge: mode === "subscribe" && token === expected ? challenge : null
  };
}

export function verifyWhatsAppSignature(rawBody, signatureHeader) {
  const secret = String(process.env.WHATSAPP_APP_SECRET || "").trim();
  const isProduction =
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production";

  if (!secret) return !isProduction;
  const header = String(signatureHeader || "");
  if (!header.startsWith("sha256=")) return false;

  const received = header.slice("sha256=".length);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graphRequest(path, options = {}) {
  const response = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${String(path).replace(/^\//, "")}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body:
        options.body && typeof options.body !== "string"
          ? JSON.stringify(options.body)
          : options.body
    }
  );

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok) {
    throw new WhatsAppGraphError(data, response.status);
  }
  return data;
}

async function sendText(to, text, extra = {}) {
  const recipient = normalizeWhatsAppRecipient(to);
  if (!recipient) throw new Error("WhatsApp recipient is missing");

  try {
    const result = await graphRequest(`${phoneNumberId()}/messages`, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: {
          preview_url: false,
          body: String(text).slice(0, 4096)
        },
        ...extra
      }
    });
    await addAuditEvent(null, "whatsapp_reply_sent", "whatsapp-outbound", {
      message_id: result?.messages?.[0]?.id || null,
      recipient_last4: recipient.slice(-4)
    }).catch(() => {});
    return result;
  } catch (error) {
    await addAuditEvent(null, "whatsapp_reply_failed", "whatsapp-outbound", {
      recipient_last4: recipient.slice(-4),
      status: error?.status ?? null,
      code: error?.code ?? null,
      subcode: error?.subcode ?? null,
      type: error?.type || null,
      details: error?.details || null,
      fbtrace_id: error?.fbtraceId || null,
      error: String(error?.message || "Unknown WhatsApp send error").slice(0, 1000)
    }).catch(() => {});
    throw error;
  }
}

async function sendReviewLink(to, text, url) {
  if (!url) return sendText(to, text);
  return graphRequest(`${phoneNumberId()}/messages`, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeWhatsAppRecipient(to),
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: String(text).slice(0, 1024) },
        action: {
          name: "cta_url",
          parameters: {
            display_text: "Review in 33Jack",
            url
          }
        }
      }
    }
  }).catch(() =>
    sendText(to, `${text}\n\nReview securely: ${url}`)
  );
}

async function markRead(messageId) {
  if (!messageId) return;
  await graphRequest(`${phoneNumberId()}/messages`, {
    method: "POST",
    body: {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId
    }
  }).catch(() => {});
}

async function retrieveMedia(mediaId, maxBytes = MAX_INVOICE_BYTES) {
  const meta = await graphRequest(
    `${mediaId}?phone_number_id=${encodeURIComponent(phoneNumberId())}`,
    { method: "GET" }
  );
  if (!meta?.url) throw new Error("WhatsApp did not return a media URL");

  const response = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken()}` }
  });
  if (!response.ok) {
    throw new Error(`WhatsApp media download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    const maxMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
    throw new Error(`WhatsApp media is over the ${maxMb} MB 33Jack limit`);
  }
  return {
    bytes,
    mimeType: meta.mime_type || response.headers.get("content-type") || "application/octet-stream"
  };
}

function messageText(message = {}) {
  return String(
    message?.text?.body ||
    message?.image?.caption ||
    message?.document?.caption ||
    message?.interactive?.button_reply?.title ||
    message?.interactive?.button_reply?.id ||
    message?.interactive?.list_reply?.title ||
    message?.interactive?.list_reply?.id ||
    message?.button?.text ||
    ""
  ).trim();
}

function mediaDescriptor(message = {}) {
  if (message.document?.id) {
    return {
      id: message.document.id,
      fileName:
        message.document.filename ||
        `whatsapp_invoice_${message.id || Date.now()}.pdf`,
      mimeType: message.document.mime_type || "application/pdf"
    };
  }
  if (message.image?.id) {
    return {
      id: message.image.id,
      fileName: `whatsapp_invoice_${message.id || Date.now()}.jpg`,
      mimeType: message.image.mime_type || "image/jpeg"
    };
  }
  return null;
}

function audioDescriptor(message = {}) {
  if (!message.audio?.id) return null;
  const mimeType = String(message.audio.mime_type || "audio/ogg");
  const extension =
    mimeType.includes("mpeg") ? "mp3" :
    mimeType.includes("mp4") ? "m4a" :
    mimeType.includes("wav") ? "wav" :
    mimeType.includes("webm") ? "webm" :
    mimeType.includes("aac") ? "aac" :
    mimeType.includes("amr") ? "amr" :
    "ogg";
  return {
    id: message.audio.id,
    fileName: `whatsapp_voice_${message.id || Date.now()}.${extension}`,
    mimeType
  };
}

async function transcribeWhatsAppAudio(message) {
  const descriptor = audioDescriptor(message);
  if (!descriptor) return "";
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Voice notes need GROQ_API_KEY before WhatsApp transcription can run");
  }

  const media = await retrieveMedia(descriptor.id, MAX_AUDIO_BYTES);
  const form = new FormData();
  form.append(
    "file",
    new Blob([media.bytes], { type: descriptor.mimeType || media.mimeType }),
    descriptor.fileName
  );
  form.append("model", WHATSAPP_TRANSCRIPTION_MODEL());
  form.append("response_format", "json");
  form.append(
    "prompt",
    "33Jack business finance voice command. Preserve supplier names, invoice references, currencies and payment amounts exactly."
  );

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `Groq voice transcription failed with HTTP ${response.status}`
    );
  }
  const transcript = String(data?.text || "").trim();
  if (!transcript) throw new Error("The WhatsApp voice note did not contain a usable transcript");
  return transcript;
}

function compactAgentPayment(payment = {}) {
  return {
    id: payment.id,
    supplier: payment.supplier || null,
    invoice: payment.invoice_number || payment.invoice_name || null,
    source_currency: payment.source_currency || null,
    source_amount: payment.source_amount == null ? null : Number(payment.source_amount),
    destination_currency: payment.destination_currency || null,
    destination_amount: payment.destination_amount || null,
    route: payment.route || payment.recommended_route || null,
    status: payment.status || null,
    risk: {
      duplicate: Boolean(payment.risk?.duplicate),
      beneficiary_changed: Boolean(payment.risk?.beneficiary_changed),
      suspicious: Boolean(payment.risk?.suspicious),
      missing_fields: Array.isArray(payment.risk?.missing_fields)
        ? payment.risk.missing_fields
        : []
    }
  };
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findReferencedWorkspacePayment(text, payments = []) {
  const query = normalized(text);
  const exact = payments.find((payment) =>
    [payment.id, payment.invoice_number, payment.invoice_name]
      .filter(Boolean)
      .some((value) => query.includes(normalized(value)))
  );
  if (exact) return exact;

  const supplierMatches = payments.filter((payment) => {
    const supplier = normalized(payment.supplier);
    return supplier && query.includes(supplier);
  });
  return supplierMatches.length === 1 ? supplierMatches[0] : null;
}

function wantsPaymentReview(text) {
  return /^\s*(pay|approve|review|settle|send)\b/i.test(String(text || "")) ||
    /\b(prepare|open)\s+(the\s+)?(payment|invoice|review)\b/i.test(String(text || ""));
}

function paymentReviewBlockers(payment = {}) {
  const blockers = [];
  if (payment.risk?.duplicate) blockers.push("duplicate");
  if (payment.risk?.beneficiary_changed) blockers.push("beneficiary changed");
  if (payment.risk?.suspicious) blockers.push("suspicious");
  if (Array.isArray(payment.risk?.missing_fields) && payment.risk.missing_fields.length) {
    blockers.push(`missing: ${payment.risk.missing_fields.join(", ")}`);
  }
  return blockers;
}

function signedReviewUrl(base, payment, whatsappUserId, workspaceId) {
  if (!base || !payment?.id) return "";
  const token = signWhatsAppLaunch({
    paymentId: payment.id,
    whatsappUserId,
    workspaceId
  });
  return `${base}/?channel=whatsapp&paymentId=${encodeURIComponent(payment.id)}&waToken=${encodeURIComponent(token)}`;
}

function scopedBeneficiaries(payments = [], beneficiaries = []) {
  const keys = new Set(
    payments.map((payment) =>
      `${normalized(payment.supplier)}|${String(payment.destination_currency || "").toUpperCase()}`
    )
  );
  return beneficiaries
    .filter((beneficiary) =>
      keys.has(
        `${normalized(beneficiary.supplier_name)}|${String(beneficiary.destination_currency || "").toUpperCase()}`
      )
    )
    .slice(0, 50)
    .map((beneficiary) => ({
      supplier: beneficiary.supplier_name,
      destination_currency: beneficiary.destination_currency,
      bank_name: beneficiary.bank_name || null,
      account_last4: beneficiary.account_last4 || null,
      country: beneficiary.country || null,
      last_seen_at: beneficiary.last_seen_at || null
    }));
}

function deterministicWorkspaceAnswer(question, payments = []) {
  const query = normalized(question);
  const { active, settled, flagged } = compactStatus(payments);
  if (/risk|attention|flag|problem/.test(query)) {
    if (!flagged.length) return "I do not see any current payment with an active risk flag in this workspace.";
    return `You have ${flagged.length} payment(s) needing risk review: ${flagged
      .slice(0, 5)
      .map((p) => `${p.supplier || p.id} (${p.invoice_number || p.id})`)
      .join(", ")}.`;
  }
  if (/settled|paid|complete/.test(query)) {
    return `${settled.length} payment(s) are settled in this workspace. ${active.length} remain active or pending.`;
  }
  return `This workspace has ${payments.length} payment record(s): ${active.length} active/pending, ${settled.length} settled and ${flagged.length} needing risk review.`;
}

async function answerWorkspaceAgent(question, workspace, payments, beneficiaries) {
  if (!process.env.GROQ_API_KEY) {
    return {
      text: deterministicWorkspaceAnswer(question, payments),
      mode: "deterministic"
    };
  }

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
  });
  const response = await client.responses.create({
    model: WHATSAPP_AGENT_MODEL(),
    input: [{
      role: "system",
      content: [{
        type: "input_text",
        text: `You are 33Jack inside WhatsApp for one business workspace.
You may read only the supplied workspace payments and beneficiary fingerprints.
Never claim to have moved, approved, cancelled or settled money from this chat.
Never reveal full bank account details.
If the user asks to pay, approve, send or settle an existing invoice, explain that 33Jack can prepare a secure review link and that final approval occurs in the controlled 33Jack flow.
If the requested payment cannot be identified from the supplied records, ask for the invoice reference or tell the user to send the invoice.
Call out duplicate, beneficiary-change, suspicious or missing-field risk clearly.
Be concise, natural and operational. Do not mention internal implementation details.`
      }]
    }, {
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({
          workspace: {
            id: workspace.id,
            name: workspace.name || null
          },
          question,
          payments: payments.map(compactAgentPayment).slice(0, 50),
          beneficiaries
        })
      }]
    }]
  });

  return {
    text: String(response.output_text || deterministicWorkspaceAnswer(question, payments)).trim(),
    mode: "groq"
  };
}


async function analyzeWhatsAppInvoice(req, message, corridor = "USD") {
  const descriptor = mediaDescriptor(message);
  if (!descriptor) return null;

  const media = await retrieveMedia(descriptor.id);
  const base = appBaseUrl(req);
  if (!base) throw new Error("PUBLIC_APP_URL is not configured");

  const response = await fetch(`${base}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: descriptor.fileName,
      mimeType: descriptor.mimeType || media.mimeType,
      fileData: media.bytes.toString("base64"),
      corridor
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || "Invoice analysis failed");
  }
  return data;
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
    "AI prepared the instruction. Exact approval and money movement stay inside 33Jack."
  ].join("\n");
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

function extractMessages(payload = {}) {
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const message of value.messages || []) {
        messages.push({
          ...message,
          metadata: value.metadata || {},
          contact: (value.contacts || [])[0] || null
        });
      }
    }
  }
  return messages;
}

function extractStatuses(payload = {}) {
  const statuses = [];
  for (const entry of payload.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const status of value.statuses || []) {
        statuses.push({
          ...status,
          metadata: value.metadata || {}
        });
      }
    }
  }
  return statuses;
}

export async function handleWhatsAppReview(req, res) {
  try {
    const paymentId = String(req.query?.paymentId || "").trim();
    const token = String(req.query?.token || "").trim();
    if (!paymentId || !token) {
      return res.status(400).json({ error: "paymentId and token are required" });
    }

    const { verifyWhatsAppLaunch } = await import("./whatsapp-auth.js");
    const auth = verifyWhatsAppLaunch(token, paymentId);
    const membership = await getTelegramWorkspaceMembership(
      `whatsapp:${auth.whatsappUserId}`
    );
    if (!membership || !roleCan(membership.member.role, "view")) {
      return res.status(403).json({ error: "WhatsApp workspace access is not available" });
    }

    const payment = await getPayment(paymentId);
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    if (
      !payment.workspace_id ||
      String(payment.workspace_id) !== String(membership.workspace.id) ||
      String(auth.workspaceId) !== String(membership.workspace.id)
    ) {
      return res.status(403).json({ error: "Payment is not available to this WhatsApp workspace" });
    }

    return res.status(200).json({
      payment,
      channel: "whatsapp",
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        role: membership.member.role,
        canApprove: roleCan(membership.member.role, "approve")
      }
    });
  } catch (error) {
    return res.status(401).json({
      error: "WhatsApp review authentication failed",
      detail: error?.message || "Unknown WhatsApp review error"
    });
  }
}

export async function sendWhatsAppPaymentReceipt({ payment, whatsappUserId, base = "" }) {
  if (!payment?.id) throw new Error("Payment is required for WhatsApp receipt");
  if (!whatsappUserId) throw new Error("WhatsApp user is required for receipt");

  const identity = `whatsapp:${whatsappUserId}`;
  const membership = await getTelegramWorkspaceMembership(identity);
  if (!membership || String(payment.workspace_id || "") !== String(membership.workspace.id)) {
    throw new Error("Payment is not available to this WhatsApp workspace");
  }

  const preferences = await getTelegramPreferences(membership.workspace.id, identity);
  if (preferences.receipt_messages === false) {
    return { ok: true, idempotent: false, suppressed: true };
  }

  if (!["settled_demo", "settled_devnet", "settled_celo"].includes(String(payment.status || ""))) {
    throw new Error(`Payment is not settled yet (current status: ${payment.status || "unknown"})`);
  }

  const events = await listAuditEvents(payment.id, 100);
  const alreadySent = events.some((event) =>
    event.event_type === "whatsapp_receipt_sent" &&
    String(event.data?.whatsapp_user_id || "") === String(whatsappUserId)
  );
  if (alreadySent) return { ok: true, idempotent: true };

  const amount = payment.source_amount && payment.source_currency
    ? `${payment.source_currency} ${Number(payment.source_amount).toLocaleString()}`
    : "—";
  const status = payment.status === "settled_devnet"
    ? "Settled on Solana Devnet"
    : "Settled in controlled demo";

  const lines = [
    "33Jack payment complete",
    "",
    `Supplier: ${payment.supplier || "—"}`,
    `Invoice: ${payment.invoice_number || payment.invoice_name || payment.id}`,
    `Invoice amount: ${amount}`,
    `Destination: ${payment.destination_amount || payment.destination_currency || "—"}`,
    `Status: ${status}`,
    "Reconciled: ✓",
    payment.settlement_signature ? `Reference: ${payment.settlement_signature}` : null
  ].filter(Boolean);

  if (payment.status === "settled_devnet" && payment.settlement_signature) {
    lines.push(
      "",
      `Solana Explorer: https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`
    );
  }
  if (base) lines.push("", `Open 33Jack: ${base}`);

  await sendText(whatsappUserId, lines.join("\n"));
  await addAuditEvent(payment.id, "whatsapp_receipt_sent", `whatsapp-user:${whatsappUserId}`, {
    whatsapp_user_id: String(whatsappUserId),
    workspace_id: membership.workspace.id,
    status: payment.status,
    settlement_signature: payment.settlement_signature || null
  });

  return { ok: true, idempotent: false };
}

export async function handleWhatsAppWebhook(req, res, rawBody) {
  if (req.method === "GET") {
    const verification = verifyWhatsAppChallenge(req);
    if (!verification.ok) {
      return res.status(403).send ? res.status(403).send("Forbidden") : res.status(403).json({ error: "Forbidden" });
    }
    if (typeof res.send === "function") return res.status(200).send(verification.challenge);
    res.statusCode = 200;
    return res.end(verification.challenge);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "GET or POST only" });
  }

  if (!verifyWhatsAppSignature(rawBody, req.headers?.["x-hub-signature-256"])) {
    return res.status(401).json({ error: "Invalid WhatsApp webhook signature" });
  }

  let payload;
  try {
    payload = rawBody?.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    return res.status(400).json({ error: "Invalid WhatsApp webhook JSON" });
  }

  const statuses = extractStatuses(payload);
  for (const status of statuses) {
    const statusName = String(status.status || "unknown");
    const statusId = String(status.id || "");
    const claimed = statusId
      ? await claimChannelMessage(`whatsapp-status-${statusName}`, statusId)
      : true;
    if (!claimed) continue;

    const errors = Array.isArray(status.errors) ? status.errors : [];
    await addAuditEvent(null, "whatsapp_delivery_status", "whatsapp-webhook", {
      whatsapp_message_id: statusId,
      status: statusName,
      recipient_last4: String(status.recipient_id || "").slice(-4) || null,
      conversation_id: String(status.conversation?.id || ""),
      pricing_model: String(status.pricing?.pricing_model || ""),
      billable: status.pricing?.billable == null ? null : Boolean(status.pricing.billable),
      error_code: errors[0]?.code ?? null,
      error_title: errors[0]?.title || null,
      error_message: errors[0]?.message || null,
      error_details: errors[0]?.error_data?.details || null
    }).catch(() => {});
  }

  const messages = extractMessages(payload);
  if (!messages.length) {
    return res.status(200).json({ ok: true, ignored: true, statuses: statuses.length });
  }

  for (const message of messages) {
    const from = String(message.from || "").trim();
    if (!from) continue;

    const inboundPhoneNumberId = String(message?.metadata?.phone_number_id || "").trim();
    if (inboundPhoneNumberId && inboundPhoneNumberId !== phoneNumberId()) {
      continue;
    }

    const claimedMessage = await claimChannelMessage("whatsapp", message.id);
    if (!claimedMessage) {
      continue;
    }

    await addAuditEvent(null, "whatsapp_message_received", "whatsapp-webhook", {
      whatsapp_message_id: String(message.id || ""),
      whatsapp_user_id: from,
      message_type: String(message.type || "unknown"),
      phone_number_id: inboundPhoneNumberId || phoneNumberId()
    });

    await markRead(message.id);
    let text = messageText(message);
    const base = appBaseUrl(req);

    try {
      const immediate = text.trim().toLowerCase();
      if (
        immediate === "help" ||
        immediate === "/help" ||
        immediate === "hi" ||
        immediate === "hello" ||
        immediate === "start" ||
        immediate === "/start"
      ) {
        await sendText(
          from,
          [
            "33Jack WhatsApp",
            "",
            "Send an invoice as PDF, JPG or PNG and I’ll prepare the payment review.",
            "You can also ask finance questions or send a voice note.",
            "",
            "Commands:",
            "STATUS · payment state",
            "TEAM · workspace members",
            "BENEFICIARIES · supplier profiles",
            "PAYOUTS · fiat payout state",
            "TRACK <payout-id> · provider status",
            "",
            "Money movement still requires the exact human approval flow in 33Jack."
          ].join("\n")
        );
        continue;
      }

      if (!text && !audioDescriptor(message) && !mediaDescriptor(message)) {
        await sendText(from, "I can currently handle text, voice notes, PDF invoices and images.");
        continue;
      }

      if (audioDescriptor(message)) {
        await sendText(from, "Voice note received. 33Jack is transcribing it…");
        text = await transcribeWhatsAppAudio(message);
        await sendText(from, `I heard: “${text.slice(0, 500)}”`);
      }
      const lower = text.toLowerCase();
      // Reuse the same workspace/RBAC backend as Telegram, but namespace the
      // messaging identity so a WhatsApp phone can never collide with a
      // Telegram numeric user id.
      const workspaceContext = await getOrCreateTelegramWorkspace({
        id: `whatsapp:${from}`,
        first_name:
          message?.contact?.profile?.name ||
          `WhatsApp ••••${from.slice(-4)}`
      });
      const workspace = workspaceContext.workspace;
      const member = workspaceContext.member;
      const identity = `whatsapp:${from}`;
      const whatsappUser = {
        id: identity,
        first_name:
          message?.contact?.profile?.name ||
          `WhatsApp ••••${from.slice(-4)}`
      };

      if (lower === "team") {
        const members = await listWorkspaceMembers(workspace.id);
        await sendText(
          from,
          [
            `33Jack team · ${workspace.name || workspace.id}`,
            "",
            ...members.map((item, index) =>
              `${index + 1}. ${item.display_name || "Member"} — ${item.role}${String(item.telegram_user_id) === identity ? " (you)" : ""}`
            ),
            "",
            roleCan(member.role, "manage_team")
              ? "Manage: INVITE <role> or ROLE <number> <role>"
              : "Your role can view the team but cannot change roles."
          ].join("\n")
        );
        continue;
      }

      if (lower.startsWith("invite ")) {
        if (!roleCan(member.role, "manage_team")) {
          await sendText(from, "Your workspace role cannot invite team members.");
          continue;
        }
        const role = lower.split(/\s+/)[1] || "viewer";
        const invite = await createWorkspaceInvite(workspace.id, identity, role, 1440);
        await sendText(
          from,
          [
            "33Jack workspace invite",
            "",
            `Role: ${invite.role}`,
            `Code: ${invite.code}`,
            "Expires: 24 hours",
            "",
            `The other person can message: JOIN ${invite.code}`
          ].join("\n")
        );
        continue;
      }

      if (lower.startsWith("join ")) {
        const code = text.split(/\s+/)[1] || "";
        const joined = await joinWorkspaceInvite(whatsappUser, code);
        await addAuditEvent(null, "workspace_member_joined", `whatsapp-user:${from}`, {
          workspace_id: joined.workspace.id,
          role: joined.member.role,
          whatsapp_user_id: from
        });
        await sendText(
          from,
          `Joined ${joined.workspace.name || joined.workspace.id} as ${joined.member.role}. Send STATUS or TEAM to continue.`
        );
        continue;
      }

      if (lower.startsWith("role ")) {
        if (!roleCan(member.role, "manage_team")) {
          await sendText(from, "Your workspace role cannot manage team roles.");
          continue;
        }
        const match = text.match(/^role\s+(\d+)\s+(owner|admin|approver|operator|viewer)$/i);
        if (!match) {
          await sendText(from, "Use: ROLE <team number> <admin|approver|operator|viewer>");
          continue;
        }
        const members = await listWorkspaceMembers(workspace.id);
        const target = members[Number(match[1]) - 1];
        if (!target) {
          await sendText(from, "That team number does not exist. Send TEAM first.");
          continue;
        }
        if (String(target.telegram_user_id) === identity) {
          await sendText(from, "You cannot change your own role from WhatsApp.");
          continue;
        }
        const changed = await setWorkspaceMemberRole(
          workspace.id,
          target.telegram_user_id,
          match[2].toLowerCase()
        );
        await addAuditEvent(null, "workspace_member_role_changed", `whatsapp-user:${from}`, {
          workspace_id: workspace.id,
          target_user_id: target.telegram_user_id,
          role: changed.role
        });
        await sendText(from, `${target.display_name || "Member"} is now ${changed.role}.`);
        continue;
      }

      if (lower === "beneficiaries") {
        const [payments, allBeneficiaries] = await Promise.all([
          listPaymentsByWorkspace(workspace.id, 100),
          listBeneficiaries(200)
        ]);
        const keys = new Set(
          payments.map((payment) =>
            `${String(payment.supplier || "").trim().toLowerCase()}|${String(payment.destination_currency || "").toUpperCase()}`
          )
        );
        const scoped = allBeneficiaries.filter((beneficiary) =>
          keys.has(
            `${String(beneficiary.supplier_name || "").trim().toLowerCase()}|${String(beneficiary.destination_currency || "").toUpperCase()}`
          )
        );
        await sendText(
          from,
          scoped.length
            ? [
                "33Jack beneficiaries",
                "",
                ...scoped.slice(0, 20).map((b, index) =>
                  `${index + 1}. ${b.supplier_name} · ${b.destination_currency || "—"} · ${b.bank_name || b.payment_handle || "profile"}${b.account_last4 ? " ••••" + b.account_last4 : ""}`
                ),
                "",
                roleCan(member.role, "manage_beneficiaries")
                  ? "Control: BLOCK Supplier | USD | reason  or  ALLOW Supplier | USD"
                  : "Your role cannot change beneficiary controls."
              ].join("\n")
            : "No settled beneficiary profiles are stored for this workspace yet."
        );
        continue;
      }

      if (lower.startsWith("block ") || lower.startsWith("allow ") || lower.startsWith("review ")) {
        if (!roleCan(member.role, "manage_beneficiaries")) {
          await sendText(from, "Your workspace role cannot manage beneficiaries.");
          continue;
        }
        const mode = lower.startsWith("block ")
          ? "blocked"
          : lower.startsWith("allow ")
            ? "allowlisted"
            : "review";
        const raw = text.replace(/^(block|allow|review)\s+/i, "");
        const [supplier, currency, ...noteParts] = raw.split("|").map((part) => part.trim());
        if (!supplier || !currency) {
          await sendText(from, "Use: BLOCK Supplier | USD | optional reason");
          continue;
        }
        const control = await setBeneficiaryControl(
          workspace.id,
          supplier,
          currency,
          mode,
          noteParts.join(" | "),
          identity
        );
        await addAuditEvent(null, "beneficiary_control_changed", `whatsapp-user:${from}`, {
          workspace_id: workspace.id,
          supplier,
          destination_currency: String(currency).toUpperCase(),
          status: control.status
        });
        await sendText(
          from,
          `${supplier} · ${String(currency).toUpperCase()} is now ${control.status}.`
        );
        continue;
      }

      if (lower === "notify") {
        const preferences = await getTelegramPreferences(workspace.id, identity);
        await sendText(
          from,
          [
            "33Jack WhatsApp notifications",
            "",
            `Payments: ${preferences.payment_updates ? "ON" : "OFF"}`,
            `Risk alerts: ${preferences.risk_alerts ? "ON" : "OFF"}`,
            `Payouts: ${preferences.payout_updates ? "ON" : "OFF"}`,
            `Receipts: ${preferences.receipt_messages ? "ON" : "OFF"}`,
            "",
            "Change: NOTIFY <PAYMENTS|RISK|PAYOUTS|RECEIPTS> <ON|OFF>"
          ].join("\n")
        );
        continue;
      }

      if (lower.startsWith("notify ")) {
        const match = text.match(/^notify\s+(payments|risk|payouts|receipts)\s+(on|off)$/i);
        if (!match) {
          await sendText(from, "Use: NOTIFY <PAYMENTS|RISK|PAYOUTS|RECEIPTS> <ON|OFF>");
          continue;
        }
        const keyMap = {
          payments: "payment_updates",
          risk: "risk_alerts",
          payouts: "payout_updates",
          receipts: "receipt_messages"
        };
        const key = keyMap[match[1].toLowerCase()];
        const enabled = match[2].toLowerCase() === "on";
        const preferences = await updateTelegramPreferences(workspace.id, identity, {
          [key]: enabled
        });
        await sendText(
          from,
          `${match[1].toUpperCase()} notifications are now ${enabled ? "ON" : "OFF"}.`
        );
        continue;
      }

      if (lower.startsWith("track ")) {
        const payoutId = text.split(/\s+/).slice(1).join(" ").trim();
        const payout = await getPayout(payoutId);
        if (!payout || String(payout.workspace_id || "") !== String(workspace.id)) {
          await sendText(from, "Payout not found in this workspace.");
          continue;
        }

        let tracked = payout;
        let tracking = null;
        if (String(payout.quote?.provider || "") === "wise_sandbox") {
          tracking = await getExternalPayoutStatus(payout);
          tracked = await savePayout({
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
            await addAuditEvent(
              payout.id,
              "fiat_payout_provider_status",
              `whatsapp-user:${from}`,
              {
                workspace_id: workspace.id,
                provider: "wise_sandbox",
                transfer_id: tracking.transferId,
                previous_status: payout.quote?.providerStatus || null,
                provider_status: tracking.providerStatus,
                local_status: tracking.localStatus
              }
            );
          }
        }

        await sendText(
          from,
          [
            "33Jack payout tracking",
            "",
            `ID: ${tracked.id}`,
            `Funding: ${tracked.funding_amount} ${tracked.funding_asset}`,
            `Destination: ${tracked.destination_amount} ${tracked.destination_currency}`,
            `Status: ${tracked.status}`,
            tracking?.friendlyStatus ? `Provider: ${tracking.friendlyStatus}` : null,
            tracking?.providerStatus ? `Wise status: ${tracking.providerStatus}` : null,
            tracked.receipt_id ? `Receipt: ${tracked.receipt_id}` : null,
            tracking?.reconciled ? "Reconciled: ✓" : null
          ].filter(Boolean).join("\n")
        );
        continue;
      }

      if (lower === "payouts") {
        const payouts = await listPayoutsByWorkspace(workspace.id, 20);
        await sendText(
          from,
          payouts.length
            ? [
                "33Jack payouts",
                "",
                ...payouts.map((payout, index) =>
                  `${index + 1}. ${payout.id} · ${payout.funding_amount} ${payout.funding_asset} → ${payout.destination_amount} ${payout.destination_currency} · ${payout.status}`
                ),
                "",
                "Send TRACK <payout-id> for provider status.",
                "Fiat payout execution remains inside the controlled 33Jack approval flow."
              ].join("\n")
            : "No fiat payout records are stored for this workspace yet."
        );
        continue;
      }

      if (lower === "status" || lower === "/status") {
        const [payments, payouts] = await Promise.all([
          listPaymentsByWorkspace(workspace.id, 50),
          listPayoutsByWorkspace(workspace.id, 50)
        ]);
        const { active, settled, flagged } = compactStatus(payments);
        await sendText(
          from,
          [
            "33Jack status",
            "",
            `Workspace: ${workspace.name || workspace.id}`,
            `Role: ${member.role}`,
            `Stored payments: ${payments.length}`,
            `Active / pending: ${active.length}`,
            `Settled: ${settled.length}`,
            `Risk review: ${flagged.length}`,
            `Fiat payouts: ${payouts.length}`
          ].join("\n")
        );
        continue;
      }

      if (mediaDescriptor(message)) {
        await sendText(from, "Invoice received. 33Jack is extracting and checking it…");
        const corridorMatch = text.match(/\b(USD|GBP|CNY|INR)\b/i);
        const analysis = await analyzeWhatsAppInvoice(
          req,
          message,
          corridorMatch?.[1]?.toUpperCase() || "USD"
        );
        if (!analysis?.id) {
          throw new Error("Invoice analysis did not return a payment id");
        }

        await assignPaymentWorkspace(analysis.id, workspace.id);
        await addAuditEvent(
          analysis.id,
          "whatsapp_invoice_attached",
          `whatsapp-user:${from}`,
          {
            workspace_id: workspace.id,
            whatsapp_user_id: from,
            role: member.role,
            file_name: mediaDescriptor(message)?.fileName || null
          }
        );

        const reviewUrl = signedReviewUrl(base, analysis, from, workspace.id);
        await sendReviewLink(from, invoiceSummary(analysis) + (reviewUrl ? "\n\nCelo wallet checkout: " + reviewUrl.replace("/?channel=", "/app/celo?channel=") : ""), reviewUrl);
        continue;
      }

      const [payments, allBeneficiaries] = await Promise.all([
        listPaymentsByWorkspace(workspace.id, 50),
        listBeneficiaries(200)
      ]);
      const beneficiaries = scopedBeneficiaries(payments, allBeneficiaries);
      const referenced = findReferencedWorkspacePayment(text, payments);
      const reviewRequested = wantsPaymentReview(text);

      if (reviewRequested && referenced) {
        const blockers = paymentReviewBlockers(referenced);
        const state = String(referenced.status || "");
        if (["settled_demo", "settled_devnet", "settled_celo"].includes(state)) {
          await sendText(
            from,
            `${referenced.supplier || "This invoice"} is already settled. Reference: ${referenced.invoice_number || referenced.invoice_name || referenced.id}.`
          );
          continue;
        }
        if (!["analyzed", "failed"].includes(state)) {
          await sendText(
            from,
            `That payment is currently ${state || "not ready"}. I won’t create a second approval path from WhatsApp.`
          );
          continue;
        }

        const answer = await answerWorkspaceAgent(text, workspace, payments, beneficiaries);
        const reviewUrl = signedReviewUrl(base, referenced, from, workspace.id);
        const riskLine = blockers.length
          ? `\n\nReview required: ${blockers.join("; ")}.`
          : "\n\nNo active deterministic risk flag is currently recorded.";
        await sendReviewLink(
          from,
          `${answer.text}${riskLine}\n\nInvoice: ${referenced.invoice_number || referenced.invoice_name || referenced.id}${reviewUrl ? "\n\nCelo wallet checkout: " + reviewUrl.replace("/?channel=", "/app/celo?channel=") : ""}`,
          reviewUrl
        );
        await addAuditEvent(
          referenced.id,
          "whatsapp_payment_review_requested",
          `whatsapp-user:${from}`,
          {
            workspace_id: workspace.id,
            whatsapp_user_id: from,
            role: member.role,
            agent_mode: answer.mode,
            risk_flags: blockers
          }
        );
        continue;
      }

      if (reviewRequested && !referenced) {
        const answer = await answerWorkspaceAgent(text, workspace, payments, beneficiaries);
        await sendText(
          from,
          `${answer.text}\n\nI need a matching invoice/payment record before I can create a secure approval link. Send the invoice or include its invoice reference.`
        );
        continue;
      }

      const answer = await answerWorkspaceAgent(text, workspace, payments, beneficiaries);
      await sendText(from, answer.text);
    } catch (error) {
      await addAuditEvent(null, "whatsapp_processing_failed", "whatsapp-webhook", {
        message_id: String(message.id || ""),
        sender_last4: from.slice(-4),
        error: String(error?.message || "Unknown error").slice(0, 1000),
        graph_code: error?.code ?? null,
        graph_subcode: error?.subcode ?? null
      }).catch(() => {});

      if (error?.name !== "WhatsAppGraphError") {
        await sendText(
          from,
          `33Jack could not process that request: ${error?.message || "Unknown error"}`
        ).catch(() => {});
      }
    }
  }

  return res.status(200).json({ ok: true });
}
