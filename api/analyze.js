import {gateLegacy} from "./_lib/legacy-access.js";
import crypto from "node:crypto";
import OpenAI from "openai";
// Keep the PDF.js worker in the Vercel serverless bundle. PDF.js uses a fake
// worker under Node and loads this file at runtime; without a static reference
// Vercel file tracing can omit it from the function package.
import "pdfjs-dist/legacy/build/pdf.worker.js";
import {
  addAuditEvent,
  findPaymentByInvoiceHash,
  getBeneficiaryHistory,
  listPayments,
  savePayment
} from "./_lib/db.js";
import { rankRoutes } from "./_lib/routing.js";

export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

const DEMO_INVOICES = {
  USD: {
    supplier: "Austin Software Inc.",
    invoice_number: "US-33018",
    source_currency: "GBP",
    source_amount: 4850,
    destination_amount: "$6,250",
    country: "US"
  },
  CNY: {
    supplier: "Shenzhen Nova Parts Ltd",
    invoice_number: "CN-44018",
    source_currency: "USD",
    source_amount: 5900,
    destination_amount: "¥42,000",
    country: "CN"
  },
  INR: {
    supplier: "Bengaluru Cloud Services Pvt Ltd",
    invoice_number: "IN-77104",
    source_currency: "USD",
    source_amount: 4850,
    destination_amount: "₹405,000",
    country: "IN"
  },
  GBP: {
    supplier: "London Creative Systems Ltd",
    invoice_number: "GB-11820",
    source_currency: "USD",
    source_amount: 6250,
    destination_amount: "£4,850",
    country: "GB"
  }
};

const fallback = (name = "supplier_invoice.pdf", corridor = "USD") => {
  const selected = DEMO_INVOICES[corridor] || DEMO_INVOICES.USD;
  return {
    id: "pay_" + Date.now().toString(36),
    invoice_name: name,
    supplier: selected.supplier,
    invoice_number: selected.invoice_number,
    source_currency: selected.source_currency,
    source_amount: selected.source_amount,
    destination_currency: corridor,
    destination_amount: selected.destination_amount,
    due_date: null,
    beneficiary: {
      name: selected.supplier,
      bank_name: "Demo Settlement Bank",
      account_last4: "1840",
      country: selected.country,
      payment_handle: null
    },
    risk: {
      duplicate: false,
      beneficiary_changed: false,
      missing_fields: [],
      suspicious: false,
      summary: "Demo analysis completed. Production beneficiary-change checks require stored beneficiary history."
    },
    confidence: 0.91,
    mode: "demo"
  };
};

function extractJson(text) {
  const cleaned = String(text || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

async function extractPdfText(fileData) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
  const getDocument = pdfjs.getDocument || pdfjs.default?.getDocument;
  if (!getDocument) throw new Error("PDF parser failed to load");
  const bytes = Uint8Array.from(Buffer.from(String(fileData || ""), "base64"));
  const task = getDocument({
    data: bytes,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const pdf = await task.promise;
  const pages = [];
  const maxPages = Math.min(pdf.numPages, 12);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (text) pages.push(`[Page ${pageNumber}] ${text}`);
  }

  return {
    text: pages.join("\n"),
    pageCount: pdf.numPages,
    extractedPages: maxPages
  };
}

function invoiceHash(fileData) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(String(fileData || ""), "base64"))
    .digest("hex");
}

function beneficiaryChanged(previous, current) {
  if (!previous || !current) return false;
  const comparable = [
    ["bank_name", previous.bank_name, current.bank_name],
    ["account_last4", previous.account_last4, current.account_last4],
    ["country", previous.country, current.country],
    ["payment_handle", previous.payment_handle, current.payment_handle]
  ].filter(([, a, b]) => a && b);

  return comparable.some(([, a, b]) =>
    String(a).trim().toLowerCase() !== String(b).trim().toLowerCase()
  );
}

function missingCoreFields(parsed) {
  const missing = [];
  if (!parsed.supplier) missing.push("supplier");
  if (!parsed.source_currency) missing.push("source_currency");
  if (!parsed.source_amount) missing.push("source_amount");
  if (!parsed.destination_currency) missing.push("destination_currency");
  return missing;
}

export default async function handler(req, res) {
  if (!gateLegacy(req,res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { fileName, mimeType, fileData, corridor = "USD" } = req.body || {};
  if (!fileName || !fileData) {
    return res.status(400).json({ error: "fileName and fileData are required" });
  }

  const hash = invoiceHash(fileData);
  const exactDuplicate = await findPaymentByInvoiceHash(hash);

  if (!process.env.GROQ_API_KEY) {
    const base = fallback(fileName, corridor);
    const history = await getBeneficiaryHistory(base.supplier, corridor);
    const changed = beneficiaryChanged(history, base.beneficiary);
    const duplicate = Boolean(exactDuplicate);
    const routing = rankRoutes({
      destinationCurrency: corridor,
      sourceAmount: base.source_amount,
      urgencyMinutes: 1440
    });

    const result = {
      ...base,
      invoice_hash: hash,
      beneficiary_history_found: Boolean(history),
      risk: {
        ...base.risk,
        duplicate,
        beneficiary_changed: changed,
        summary: duplicate
          ? "Exact invoice file already exists in 33jack payment history."
          : changed
            ? "Beneficiary details differ from the stored supplier profile and require explicit acknowledgement."
            : base.risk.summary
      },
      recommended_route: routing.best?.label || `GBP → USDC/Solana → ${corridor}`,
      route_options: routing,
      quote_mode: routing.mode
    };

    const saved = await savePayment({
      ...result,
      route: result.recommended_route,
      status: "analyzed"
    });
    await addAuditEvent(saved.id, "invoice_analyzed", "33jack-agent", {
      mode: "demo",
      invoice_hash: hash,
      duplicate,
      beneficiary_changed: changed
    });

    return res.status(200).json({
      ...result,
      notice: "GROQ_API_KEY is not configured; deterministic demo analysis returned."
    });
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1"
    });
    const lowerName = fileName.toLowerCase();
    const inferredType =
      lowerName.endsWith(".webp") ? "image/webp" :
      lowerName.endsWith(".png") ? "image/png" :
      lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg") ? "image/jpeg" :
      lowerName.endsWith(".pdf") ? "application/pdf" :
      lowerName.endsWith(".txt") ? "text/plain" :
      "";
    const type = String(mimeType || inferredType);
    const isImage = type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(fileName);
    const isPdf = type === "application/pdf" || lowerName.endsWith(".pdf");

    let decodedText = null;
    let pdfMeta = null;

    if (isPdf) {
      pdfMeta = await extractPdfText(fileData);
      decodedText = pdfMeta.text;

      if (!decodedText || decodedText.trim().length < 20) {
        return res.status(422).json({
          error: "This PDF appears to be scanned or image-only",
          detail: "Text-based PDFs are supported. For scanned PDFs, upload the page as PNG, JPG, or WEBP for Groq vision analysis."
        });
      }
    } else if (!isImage) {
      decodedText = Buffer.from(String(fileData || ""), "base64").toString("utf8");
    }

    const prompt = `You are 33jack's invoice-risk analyst.
Extract the commercial payment instruction from this invoice and return ONLY valid JSON.
Never invent missing values. Flag uncertainty.
Target payout currency requested by the UI: ${corridor}.

JSON shape:
{
  "supplier": string|null,
  "invoice_number": string|null,
  "source_currency": string|null,
  "source_amount": number|null,
  "destination_currency": string|null,
  "destination_amount": string|null,
  "due_date": string|null,
  "beneficiary": {
    "name": string|null,
    "bank_name": string|null,
    "account_last4": string|null,
    "country": string|null,
    "payment_handle": string|null
  },
  "risk": {
    "suspicious": boolean,
    "missing_fields": string[],
    "summary": string
  },
  "confidence": number
}

Privacy rule: never return a full bank-account number. If an account number is present, return only its final four characters as account_last4.
Do not claim duplicate detection or beneficiary-history verification; 33jack performs those checks deterministically after extraction.`;

    const response = await client.responses.create({
      model: isImage
        ? (process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b")
        : (process.env.GROQ_AGENT_MODEL || "openai/gpt-oss-20b"),
      input: isImage
        ? [{
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              {
                type: "input_image",
                image_url: `data:${type};base64,${fileData}`,
                detail: "auto"
              }
            ]
          }]
        : `${prompt}\n\nInvoice source: ${isPdf ? "PDF" : "text"}\n${pdfMeta ? `PDF pages: ${pdfMeta.pageCount}; extracted pages: ${pdfMeta.extractedPages}\n` : ""}\nInvoice text:\n${decodedText}`
    });

    const parsed = extractJson(response.output_text);
    const previous = await listPayments(100);
    const semanticDuplicate = previous.some((p) =>
      p.invoice_number &&
      parsed.invoice_number &&
      String(p.invoice_number).trim().toLowerCase() === String(parsed.invoice_number).trim().toLowerCase() &&
      String(p.supplier || "").trim().toLowerCase() === String(parsed.supplier || "").trim().toLowerCase() &&
      String(p.status || "") !== "rejected"
    );

    const history = await getBeneficiaryHistory(
      parsed.supplier,
      parsed.destination_currency || corridor
    );
    const changed = beneficiaryChanged(history, parsed.beneficiary);
    const duplicate = Boolean(exactDuplicate || semanticDuplicate);
    const missing = Array.from(new Set([
      ...(Array.isArray(parsed.risk?.missing_fields) ? parsed.risk.missing_fields : []),
      ...missingCoreFields(parsed)
    ]));

    const routing = rankRoutes({
      destinationCurrency: parsed.destination_currency || corridor,
      sourceAmount: parsed.source_amount || 0,
      urgencyMinutes: 1440
    });

    const risk = {
      ...(parsed.risk || {}),
      duplicate,
      beneficiary_changed: changed,
      missing_fields: missing,
      summary: duplicate
        ? "33jack found this invoice, or the same supplier/invoice number, in payment history."
        : changed
          ? "Beneficiary details differ from the stored supplier profile and require explicit acknowledgement."
          : parsed.risk?.summary || "No deterministic duplicate or beneficiary-change signal found."
    };

    const result = {
      id: "pay_" + Date.now().toString(36),
      invoice_name: fileName,
      invoice_hash: hash,
      ...parsed,
      risk,
      beneficiary_history_found: Boolean(history),
      recommended_route: routing.best?.label ||
        `${parsed.source_currency || "GBP"} → USDC/Solana → ${parsed.destination_currency || corridor}`,
      route_options: routing,
      quote_mode: routing.mode,
      mode: "groq"
    };

    const saved = await savePayment({
      ...result,
      route: result.recommended_route,
      status: "analyzed"
    });

    await addAuditEvent(saved.id, "invoice_analyzed", "33jack-agent", {
      mode: "groq",
      invoice_hash: hash,
      confidence: parsed.confidence ?? null,
      duplicate,
      beneficiary_changed: changed,
      missing_fields: missing,
      route_id: routing.best?.id || null
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("invoice analysis failed", error);
    return res.status(500).json({
      error: "Invoice analysis failed",
      detail: error?.message || "Unknown error"
    });
  }
}
