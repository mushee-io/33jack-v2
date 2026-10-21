import {gateLegacy} from "./_lib/legacy-access.js";
import OpenAI from "openai";
import { listBeneficiaries, listPayments } from "./_lib/db.js";
import { handleTelegramMiniAppAction, handleTelegramWebhook } from "./_lib/telegram.js";
import { handleWhatsAppReview, handleWhatsAppWebhook } from "./_lib/whatsapp.js";
import { handleWeChatReview, handleWeChatWebhook } from "./_lib/wechat.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseJsonBody(raw) {
  if (!raw?.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

const MAX_VOICE_AUDIO_BYTES = 3 * 1024 * 1024;

function voiceMimeType(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  const allowed = new Set([
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/m4a",
    "video/webm",
    "video/mp4"
  ]);
  return allowed.has(mime) ? mime : "audio/webm";
}

function voiceExtension(mime) {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "webm";
}

async function handleVoiceTranscription(body, res) {
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(503).json({
      error: "Voice transcription is not configured",
      detail: "GROQ_API_KEY is missing"
    });
  }

  const audioData = String(body?.audioData || "").trim();
  const mimeType = voiceMimeType(body?.mimeType);
  if (!audioData) {
    return res.status(400).json({ error: "No voice recording received" });
  }

  const bytes = Buffer.from(audioData, "base64");
  if (!bytes.length) {
    return res.status(400).json({ error: "Voice recording was empty" });
  }
  if (bytes.length > MAX_VOICE_AUDIO_BYTES) {
    return res.status(413).json({
      error: "Voice recording is too large",
      detail: "Keep each 33Jack voice command under a few seconds."
    });
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: mimeType }),
    `33jack-command.${voiceExtension(mimeType)}`
  );
  form.append(
    "model",
    String(process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo").trim()
  );
  form.append("response_format", "json");
  form.append("language", "en");
  form.append(
    "prompt",
    "33Jack business finance voice command. Preserve person and company names, invoice references, currencies and amounts exactly."
  );

  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: "Voice transcription failed",
        detail:
          data?.error?.message ||
          data?.message ||
          `Groq returned HTTP ${response.status}`
      });
    }

    const transcript = String(data?.text || "").trim();
    if (!transcript) {
      return res.status(422).json({
        error: "I could not hear a command in that recording",
        detail: "Try again and speak a little closer to the microphone."
      });
    }

    return res.status(200).json({
      ok: true,
      transcript,
      model: String(process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo").trim()
    });
  } catch (error) {
    return res.status(500).json({
      error: "Voice transcription failed",
      detail: error instanceof Error ? error.message : "Unexpected transcription error"
    });
  }
}

function compactPayment(p) {
  return {
    id: p.id,
    supplier: p.supplier || null,
    invoice: p.invoice_number || p.invoice_name || null,
    source_currency: p.source_currency || null,
    source_amount: p.source_amount == null ? null : Number(p.source_amount),
    destination_currency: p.destination_currency || null,
    destination_amount: p.destination_amount || null,
    route: p.route || null,
    status: p.status || null,
    risk: {
      duplicate: Boolean(p.risk?.duplicate),
      beneficiary_changed: Boolean(p.risk?.beneficiary_changed),
      suspicious: Boolean(p.risk?.suspicious),
      missing_fields: Array.isArray(p.risk?.missing_fields) ? p.risk.missing_fields : []
    },
    created_at: p.created_at || null
  };
}

function findReferencedPayment(message, payments = []) {
  const text = String(message || "").toLowerCase();
  return payments.find((p) =>
    [p.id, p.invoice]
      .filter(Boolean)
      .some((value) => text.includes(String(value).toLowerCase()))
  ) || null;
}

function buildProposal(message, payments = []) {
  const lower = String(message || "").toLowerCase();
  const wantsPreparation = /\b(prepare|pay|execute|settle|send)\b/.test(lower);
  if (!wantsPreparation) return null;

  const payment = findReferencedPayment(message, payments);
  if (!payment) return null;

  const stablecoins = new Set(["USDG", "USDC", "USDT"]);
  const unit = stablecoins.has(String(payment.destination_currency || "").toUpperCase())
    ? "33Jack Crypto"
    : "33Jack Pay";
  const flags = [];
  if (payment.risk?.duplicate) flags.push("duplicate");
  if (payment.risk?.beneficiary_changed) flags.push("beneficiary_changed");
  if (payment.risk?.suspicious) flags.push("suspicious");
  if (Array.isArray(payment.risk?.missing_fields)) flags.push(...payment.risk.missing_fields);

  return {
    paymentId: payment.id,
    invoice: payment.invoice,
    supplier: payment.supplier,
    unit,
    sourceCurrency: payment.source_currency,
    sourceAmount: payment.source_amount,
    destinationCurrency: payment.destination_currency,
    destinationAmount: payment.destination_amount,
    route: payment.route,
    status: payment.status,
    blockers: Array.from(new Set(flags.filter(Boolean))),
    readyForStructuredFlow: flags.length === 0 && ["analyzed", "failed"].includes(String(payment.status || ""))
  };
}

function fallbackAnswer(message, payments) {
  const risky = payments.filter((p) =>
    p.risk?.duplicate ||
    p.risk?.beneficiary_changed ||
    p.risk?.suspicious ||
    (Array.isArray(p.risk?.missing_fields) && p.risk.missing_fields.length)
  );
  const pending = payments.filter((p) =>
    ["analyzed", "approved", "settling", "failed"].includes(String(p.status || ""))
  );
  const settled = payments.filter((p) =>
    ["settled_demo", "settled_devnet"].includes(String(p.status || ""))
  );

  const lower = String(message || "").toLowerCase();
  if (lower.includes("risk") || lower.includes("attention") || lower.includes("problem")) {
    if (!risky.length) return "I do not see any currently stored payment with an active risk flag.";
    return `You have ${risky.length} payment${risky.length === 1 ? "" : "s"} needing risk review: ${risky
      .slice(0, 5)
      .map((p) => `${p.supplier || p.id} (${p.id})`)
      .join(", ")}.`;
  }
  if (lower.includes("failed")) {
    const failed = payments.filter((p) => p.status === "failed");
    return failed.length
      ? `There are ${failed.length} failed payment${failed.length === 1 ? "" : "s"}: ${failed.map((p) => p.id).join(", ")}.`
      : "I do not see any failed payments in the current 33jack records.";
  }
  return `33jack currently has ${payments.length} payment record${payments.length === 1 ? "" : "s"}: ${pending.length} pending/active, ${settled.length} settled, and ${risky.length} carrying risk flags. Ask me about a supplier, invoice, payment status, failures, or what needs attention.`;
}

export default async function handler(req, res) {
  const provider = String(req.query?.provider || "").toLowerCase();

  if (provider === "whatsapp" && req.method === "GET") {
    return handleWhatsAppWebhook(req, res, Buffer.alloc(0));
  }

  if (provider === "wechat" && req.method === "GET") {
    return handleWeChatWebhook(req, res, Buffer.alloc(0));
  }

  if (provider === "whatsapp-review" && req.method === "GET") {
    return handleWhatsAppReview(req, res);
  }

  if (provider === "wechat-review" && req.method === "GET") {
    return handleWeChatReview(req, res);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: "Could not read request body" });
  }

  if (provider === "whatsapp") {
    return handleWhatsAppWebhook(req, res, rawBody);
  }

  if (provider === "wechat") {
    return handleWeChatWebhook(req, res, rawBody);
  }

  let body;
  try {
    body = parseJsonBody(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  req.body = body;

  if (provider === "voice-transcribe") {
    return handleVoiceTranscription(body, res);
  }

  if (provider === "telegram") {
    return handleTelegramWebhook(req, res);
  }

  if (provider === "telegram-miniapp") {
    return handleTelegramMiniAppAction(req, res);
  }

  if (!gateLegacy(req,res)) return;
  const message = String(body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "message is required" });
  if (message.length > 2000) return res.status(400).json({ error: "message is too long" });

  const [paymentRows, beneficiaryRows] = await Promise.all([
    listPayments(50),
    listBeneficiaries(50)
  ]);
  const payments = paymentRows.map(compactPayment);
  const proposal = buildProposal(message, payments);
  const beneficiaries = beneficiaryRows.map((b) => ({
    supplier: b.supplier_name,
    destination_currency: b.destination_currency,
    bank_name: b.bank_name,
    account_last4: b.account_last4,
    country: b.country,
    last_seen_at: b.last_seen_at
  }));

  if (!process.env.GROQ_API_KEY) {
    return res.status(200).json({
      answer: proposal
        ? `I prepared a controlled ${proposal.unit} proposal for ${proposal.invoice || proposal.paymentId}. ${proposal.blockers.length ? "It still has blockers: " + proposal.blockers.join(", ") + "." : "It is ready to enter the structured approval flow."}`
        : fallbackAnswer(message, payments),
      proposal,
      mode: "deterministic",
      canExecute: false
    });
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1"
    });
    const response = await client.responses.create({
      model: process.env.GROQ_AGENT_MODEL || "openai/gpt-oss-20b",
      input: [{
        role: "system",
        content: [{
          type: "input_text",
          text: `You are 33jack, a business finance operations assistant.
You operate across three product units:
- 33Jack Pay: stablecoin-funded fiat payouts through regulated payout/FX partners.
- 33Jack Crypto: stablecoin-to-stablecoin vendor and contractor payouts.
- 33Jack Invoice: invoice creation, extraction, verification, risk checks and payment-state intelligence.
When useful, identify which unit should handle the user's request.
You can inspect the supplied 33jack payment and beneficiary state and explain it clearly.
You are READ-ONLY in this endpoint. Never claim you executed, approved, cancelled, retried, or moved money.
Do not invent information that is absent.
When a payment has risk flags, mention the concrete flags.
When asked to execute money movement, explain that the user must use the structured approval/payment flow.
Be concise and operational.`
        }]
      }, {
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify({
            question: message,
            payments,
            beneficiaries
          })
        }]
      }]
    });

    return res.status(200).json({
      answer: response.output_text || fallbackAnswer(message, payments),
      proposal,
      mode: "groq",
      canExecute: false
    });
  } catch (error) {
    return res.status(500).json({
      error: "Agent failed",
      detail: error?.message || "Unknown error"
    });
  }
}
