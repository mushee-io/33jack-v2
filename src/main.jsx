import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  Bot,
  Building2,
  Coins,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FilePlus2,
  FileText,
  Globe2,
  Landmark,
  LayoutDashboard,
  Menu,
  MessageCircleMore,
  Mic,
  Volume2,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Trash2,
  UploadCloud,
  Wallet,
  WalletCards,
  X,
  Zap
} from "lucide-react";
import "./styles.css";
import CeloWorkspace from "./CeloWorkspace.jsx";

const samplePayments = [
  { company: "Austin Software Inc.", invoice: "US-33018", amount: "$6,250", route: "GBP → USDG → USD", status: "Settled", time: "12 min ago" },
  { company: "Shenzhen Nova Parts", invoice: "CN-44018", amount: "¥42,000", route: "USD → USDG → CNY", status: "Review", time: "1 hr ago" },
  { company: "Bengaluru Cloud Services", invoice: "IN-77104", amount: "₹405,000", route: "USD → USDG → INR", status: "Settled", time: "2 hrs ago" },
  { company: "London Creative Systems", invoice: "GB-11820", amount: "£4,850", route: "USD → USDG → GBP", status: "Review", time: "Yesterday" },
];

const nav = [
  ["Overview", LayoutDashboard],
  ["Agent", Bot],
  ["Voice Pay β", Mic],
  ["Jack Swipe β", ReceiptText],
  ["Channels", MessageCircleMore],
  ["33Jack Pay", Landmark],
  ["33Jack Crypto", Coins],
  ["33Jack Invoice", FilePlus2],
  ["Settlement Network", Globe2],
  ["Celo Mainnet", Wallet],
  ["Payments", CircleDollarSign],
  ["Beneficiaries", WalletCards],
  ["Approvals", ShieldCheck],
];

const APP_ROUTES = {
  "Overview": "/app",
  "Agent": "/app/agent",
  "Voice Pay β": "/app/voice-pay",
  "Jack Swipe β": "/app/jack-swipe",
  "Channels": "/app/channels",
  "33Jack Pay": "/app/pay",
  "33Jack Crypto": "/app/crypto",
  "33Jack Invoice": "/app/invoice",
  "Settlement Network": "/app/settlement-network",
  "Celo Mainnet": "/app/celo",
  "Payments": "/app/payments",
  "Beneficiaries": "/app/beneficiaries",
  "Approvals": "/app/approvals"
};

const PATH_TO_VIEW = Object.fromEntries(Object.entries(APP_ROUTES).map(([view, path]) => [path, view]));

function viewFromLocation() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  if (path === "/app/overview") return "Overview";
  if (PATH_TO_VIEW[path]) return PATH_TO_VIEW[path];
  const requested = new URLSearchParams(window.location.search).get("view");
  return nav.some(([label]) => label === requested) ? requested : "Overview";
}

function appHref(view = "Overview") {
  return APP_ROUTES[view] || APP_ROUTES.Overview;
}

const steps = [
  ["Invoice received", "AI extracted supplier, amount, due date and banking instructions.", FileText],
  ["Risk checks", "Duplicate scan, beneficiary-change check and missing-field validation.", ShieldCheck],
  ["Route prepared", "Compared settlement options and prepared an exact payment proposal.", RefreshCw],
  ["Approval", "Human approval is bound to amount, beneficiary, route and expiry.", BadgeCheck],
  ["Settlement", "USDG settles on Solana, then the local payout partner completes delivery.", Zap],
  ["Reconciliation", "Payment evidence is matched back to the invoice automatically.", FileCheck2],
];

const subunits = [
  {
    name: "33Jack Pay",
    eyebrow: "STABLECOIN → FIAT",
    description: "Fund with stablecoins, pay approved vendors in their local currency through payout partners.",
    status: "Sandbox route",
    icon: Landmark,
    bullets: ["USDG / USDC / USDT funding", "FX + payout quote", "Local bank delivery", "Receipt + reconciliation"]
  },
  {
    name: "33Jack Crypto",
    eyebrow: "STABLECOIN → STABLECOIN",
    description: "Invoice-led wallet payouts for vendors, contractors and crypto-native teams.",
    status: "Devnet live",
    icon: Coins,
    bullets: ["USDG on Solana", "Exact approval binding", "Wallet settlement", "Onchain proof"]
  },
  {
    name: "33Jack Invoice",
    eyebrow: "INVOICE INTELLIGENCE",
    description: "Create, read and verify payment instructions before either payment rail is used.",
    status: "Live",
    icon: FilePlus2,
    bullets: ["Groq extraction", "Invoice creator", "Risk + duplicate checks", "Payment status"]
  },
  {
    name: "Voice Pay β",
    eyebrow: "VOICE PAYMENT BETA",
    description: "Say who to pay and how much. 33Jack turns the conversation into a reviewable invoice and waits for explicit approval.",
    status: "Beta",
    icon: Mic,
    bullets: ["Voice intent", "Amount confirmation", "Invoice preview", "Human-approved send"]
  },
  {
    name: "Jack Swipe β",
    eyebrow: "SWIPE-TO-PAY BETA",
    description: "Invoices surface like actionable notifications. Swipe an eligible invoice to let 33Jack approve, settle and return the receipt.",
    status: "Beta",
    icon: ReceiptText,
    bullets: ["Invoice pop-up", "Swipe approval", "Agent settlement", "Instant receipt"]
  }
];

function Logo() {
  return <div className="brand"><span className="brand-mark">33</span><span>jack</span><i /></div>;
}

function StatusPill({ status }) {
  const tone = status === "Settled" ? "good" : status === "Flagged" ? "bad" : "warn";
  return <span className={"pill " + tone}>{status}</span>;
}

function Metric({ label, value, sub, accent }) {
  return (
    <div className="metric card">
      <div className="metric-top">
        <span>{label}</span>
        {accent && <span className="metric-accent">{accent}</span>}
      </div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

async function readApiResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {
      error: response.ok ? "Unexpected server response" : "Server error",
      detail: text || `HTTP ${response.status}`
    };
  }
}

async function deleteStoredRecord(kind, id, label = "this record") {
  if (!id) return { deleted: false, cancelled: true };

  const confirmed = window.confirm(
    `Permanently delete ${label} from 33JACK live storage? This removes the stored record from Neon and cannot be undone.`
  );
  if (!confirmed) return { deleted: false, cancelled: true };

  const storageKey = "33jack.recordDeleteSecret";
  let secret = window.sessionStorage.getItem(storageKey) || "";
  if (!secret) {
    secret = window.prompt("Enter the 33JACK record delete key.") || "";
    if (!secret) return { deleted: false, cancelled: true };
  }

  const response = await fetch("/api/payments", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-33Jack-Delete-Secret": secret
    },
    body: JSON.stringify({ kind, id })
  });
  const data = await readApiResponse(response);

  if (response.status === 401) {
    window.sessionStorage.removeItem(storageKey);
    window.alert("That delete key is not valid.");
    return { deleted: false, error: "invalid_key" };
  }
  if (!response.ok) {
    window.alert(data.detail || data.error || "Could not delete the record.");
    return { deleted: false, error: data.error || "delete_failed" };
  }

  window.sessionStorage.setItem(storageKey, secret);
  return data;
}

const STABLECOINS = new Set(["USDG", "USDC", "USDT"]);

function formatMoney(value, currency) {
  const amount = Number(value);
  const code = String(currency || "").trim().toUpperCase();
  if (!Number.isFinite(amount)) return value == null ? "—" : String(value);
  if (!code) return amount.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  if (STABLECOINS.has(code)) {
    return `${amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${code}`;
  }
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${code}`;
  }
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("33jack UI render error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#070b10",color:"#eef2f7",padding:24}}>
          <div style={{maxWidth:620,border:"1px solid #263246",background:"#0d141d",borderRadius:16,padding:28}}>
            <span className="eyebrow">33JACK RECOVERY</span>
            <h2 style={{margin:"8px 0"}}>The payment view hit a display error.</h2>
            <p style={{color:"#8491a3",fontSize:11,lineHeight:1.6}}>Your stored payment data is still intact. Reload the interface to continue.</p>
            <button className="primary" onClick={() => window.location.reload()}>Reload 33Jack</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function PaymentFlow({ close, onComplete, initialPayment = null, channelContext = null }) {
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [stage, setStage] = useState("upload");
  const [settleStep, setSettleStep] = useState(0);
  const [corridor, setCorridor] = useState("USD");
  const [analysis, setAnalysis] = useState(null);
  const [settlement, setSettlement] = useState(null);
  const [error, setError] = useState("");
  const [acknowledgements, setAcknowledgements] = useState({
    duplicate: false,
    beneficiary_changed: false,
    suspicious: false
  });

  useEffect(() => {
    if (!initialPayment?.id) return;
    setAnalysis(initialPayment);
    setFileName(initialPayment.invoice_name || initialPayment.invoice_number || "Channel invoice");
    setCorridor(String(initialPayment.destination_currency || "USD").toUpperCase());
    setStage("review");
  }, [initialPayment]);

  const result = useMemo(() => {
    if (!analysis) {
      const demo = {
        USD: { supplier: "Austin Software Inc.", amount: "$6,250", funding: "£4,850.00", eta: "20 min est.", source: "GBP" },
        CNY: { supplier: "Shenzhen Nova Parts Ltd", amount: "¥42,000", funding: "$5,900.00", eta: "4 hr est.", source: "USD" },
        INR: { supplier: "Bengaluru Cloud Services Pvt Ltd", amount: "₹405,000", funding: "$4,850.00", eta: "45 min est.", source: "USD" },
        GBP: { supplier: "London Creative Systems Ltd", amount: "£4,850", funding: "$6,250.00", eta: "20 min est.", source: "USD" }
      }[corridor];
      return {
        supplier: demo.supplier,
        amount: demo.amount,
        funding: demo.funding,
        fee: "Calculated at quote",
        eta: demo.eta,
        route: `${demo.source} → USDG/Solana → ${corridor}`,
        risk: { duplicate: false, beneficiary_changed: false, suspicious: false, missing_fields: [] }
      };
    }
    return {
      supplier: analysis.supplier || "Supplier not extracted",
      amount: analysis.destination_amount || "Quoted at execution",
      funding: analysis.source_amount && analysis.source_currency
        ? formatMoney(analysis.source_amount, analysis.source_currency)
        : "Confirm from invoice",
      fee: analysis.route_options?.best?.estimatedFee != null
        ? `£${Number(analysis.route_options.best.estimatedFee).toFixed(2)} est.`
        : "Calculated at quote",
      eta: analysis.route_options?.best?.etaMinutes
        ? `${analysis.route_options.best.etaMinutes} min est.`
        : corridor === "CNY" ? "Same business day" : "< 10 minutes",
      route: analysis.recommended_route || `${analysis.source_currency || "GBP"} → USDG/Solana → ${analysis.destination_currency || corridor}`,
      risk: analysis.risk || {}
    };
  }, [analysis, corridor]);

  function fileToBase64(selected) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(selected);
    });
  }

  async function runAnalysis() {
    setError("");
    setStage("analyzing");
    try {
      let payload;
      if (file) {
        if (file.size > 3.2 * 1024 * 1024) throw new Error("For the live demo, keep invoices under 3.2 MB.");
        payload = {
          fileName: file.name,
          mimeType: file.type || "application/pdf",
          fileData: await fileToBase64(file),
          corridor
        };
      } else {
        const demos = {
          USD: ["Austin Software Inc.", "GBP 4,850"],
          CNY: ["Shenzhen Nova Parts Ltd", "USD 5,900"],
          INR: ["Bengaluru Cloud Services Pvt Ltd", "USD 4,850"],
          GBP: ["London Creative Systems Ltd", "USD 6,250"]
        };
        const [demoSupplier, demoAmount] = demos[corridor];
        const demoText = `INVOICE 33J-DEMO-0926-${corridor}
Supplier: ${demoSupplier}
Amount due: ${demoAmount}
Target payout currency: ${corridor}
Due: 30 September 2026
Beneficiary details: demo account ending 1840
Please settle this approved supplier invoice.`;
        payload = {
          fileName: "33jack_demo_invoice.txt",
          mimeType: "text/plain",
          fileData: btoa(demoText),
          corridor
        };
        setFileName("33jack_demo_invoice.txt");
      }

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Analysis failed");
      setAnalysis(data);
      setStage("review");
    } catch (e) {
      setError(e.message || "Analysis failed");
      setStage("upload");
    }
  }

  async function approve() {
    setError("");
    setStage("settling");
    setSettleStep(1);
    try {
      const paymentId = analysis?.id || "pay_" + Date.now().toString(36);
      const approvalResponse = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId,
          acknowledgements,
          amountUsdg: 1,
          ...(channelContext?.channel === "whatsapp"
            ? {
                channel: "whatsapp",
                whatsappLaunchToken: channelContext.token
              }
            : channelContext?.channel === "wechat"
              ? {
                  channel: "wechat",
                  wechatLaunchToken: channelContext.token
                }
              : {})
        })
      });
      const approval = await readApiResponse(approvalResponse);
      if (!approvalResponse.ok) {
        if (approvalResponse.status === 409 && approval.refreshedPayout) {
          setQuote(approval.refreshedPayout);
          setError("Quote refreshed automatically. Review the updated amount and approve again.");
          return;
        }
        throw new Error(approval.detail || approval.error || "Approval failed");
      }

      setSettleStep(2);
      const response = await fetch("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalToken: approval.approvalToken })
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Settlement failed");
      setSettleStep(3);
      setSettlement({ ...data, approvalMode: approval.mode });
      setTimeout(() => {
        setSettleStep(4);
        setStage("done");
        onComplete?.();
      }, 700);
    } catch (e) {
      setError(e.message || "Settlement failed");
      setStage("review");
    }
  }

  const duplicateKnown = Boolean(result.risk?.duplicate);
  const beneficiaryChanged = Boolean(result.risk?.beneficiary_changed);
  const suspicious = Boolean(result.risk?.suspicious);
  const missing = Array.isArray(result.risk?.missing_fields) ? result.risk.missing_fields : [];

  return (
    <div className="modal-wrap" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">NEW PAYMENT</span>
            <h2>Invoice → settlement</h2>
          </div>
          <button className="icon-btn" onClick={close}>×</button>
        </div>

        {error && <div style={{margin:"14px 24px 0",padding:"10px 12px",border:"1px solid rgba(255,111,125,.25)",borderRadius:10,color:"#ff8994",fontSize:11}}>{error}</div>}

        {stage === "upload" && (
          <div className="flow-body">
            <div className="flow-copy">
              <h3>Give 33jack the invoice.</h3>
              <p>The agent extracts the payment instruction, checks risk, prepares a route and asks for one exact approval.</p>
            </div>
            <label className="dropzone">
              <UploadCloud size={28} />
              <strong>{fileName || "Drop invoice here"}</strong>
              <span>PDF, PNG, JPG, WEBP or TXT · up to 3.2 MB · Groq live analysis</span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain"
                onChange={(e) => {
                  const selected = e.target.files?.[0] || null;
                  setFile(selected);
                  setFileName(selected?.name || "");
                }}
              />
            </label>
            <div className="corridor-row">
              <button className={corridor === "USD" ? "chip active" : "chip"} onClick={() => setCorridor("USD")}>United States · USD</button>
              <button className={corridor === "CNY" ? "chip active" : "chip"} onClick={() => setCorridor("CNY")}>China · CNY</button>
              <button className={corridor === "INR" ? "chip active" : "chip"} onClick={() => setCorridor("INR")}>India · INR</button>
              <button className={corridor === "GBP" ? "chip active" : "chip"} onClick={() => setCorridor("GBP")}>United Kingdom · GBP</button>
            </div>
            <button className="primary wide" onClick={runAnalysis}><Sparkles size={17}/> Analyse invoice <ArrowRight size={17}/></button>
          </div>
        )}

        {stage === "analyzing" && (
          <div className="analyzing">
            <div className="pulse-orb"><Bot size={30}/></div>
            <h3>33jack is checking the payment</h3>
            <p>Extracting invoice · checking payment risk · preparing settlement route</p>
            <div className="progress"><i /></div>
          </div>
        )}

        {stage === "review" && (
          <div className="review-grid">
            <div className="analysis-card">
              <span className="eyebrow">{analysis?.mode === "groq" ? "LIVE GROQ RISK REVIEW" : "DEMO RISK REVIEW"}</span>
              <h3>{fileName || analysis?.invoice_name || "invoice"}</h3>
              <div className="check-list">
                <div className={duplicateKnown ? "warning" : ""}>
                  {duplicateKnown ? <TriangleAlert/> : <CheckCircle2/>}
                  <span><b>{duplicateKnown ? "Possible duplicate detected" : "No duplicate signal in this analysis"}</b><small>{duplicateKnown ? "Stop and compare against payment history before execution." : "Production duplicate detection also compares stored invoice history."}</small></span>
                </div>
                <div className={suspicious ? "warning" : ""}>
                  {suspicious ? <TriangleAlert/> : <CheckCircle2/>}
                  <span><b>{suspicious ? "Suspicious invoice signal" : "Invoice structure parsed"}</b><small>{result.risk?.summary || "33jack extracted the payment instruction and surfaced uncertainty."}</small></span>
                </div>
                <div className={beneficiaryChanged ? "warning" : ""}>
                  {beneficiaryChanged ? <TriangleAlert/> : <CheckCircle2/>}
                  <span><b>{beneficiaryChanged ? "Beneficiary change needs acknowledgement" : "No beneficiary-change claim"}</b><small>{beneficiaryChanged ? "The proposed payment is blocked behind explicit acknowledgement." : "Historical verification is only definitive when beneficiary history is available."}</small></span>
                </div>
                <div className={missing.length ? "warning" : ""}>
                  {missing.length ? <TriangleAlert/> : <CheckCircle2/>}
                  <span><b>{missing.length ? "Missing information" : "Required fields present"}</b><small>{missing.length ? missing.join(", ") : "No missing fields were reported by the current analysis."}</small></span>
                </div>
              </div>
            </div>
            <div className="proposal">
              <span className="eyebrow">EXACT PAYMENT PROPOSAL</span>
              <h3>{result.supplier}</h3>
              <div className="proposal-amount">{result.amount}</div>
              <div className="proposal-lines">
                <p><span>You fund</span><b>{result.funding}</b></p>
                <p><span>Settlement</span><b>Solana · USDG</b></p>
                <p><span>Service + FX</span><b>{result.fee}</b></p>
                <p><span>Delivery target</span><b>{result.eta}</b></p>
              </div>
              <div className="route">
                <span>{analysis?.source_currency || "GBP"}</span><ArrowRight/><span>USDG</span><ArrowRight/><span>{analysis?.destination_currency || corridor}</span>
              </div>
              {duplicateKnown && (
                <label className="ack">
                  <input
                    type="checkbox"
                    checked={acknowledgements.duplicate}
                    onChange={(e) => setAcknowledgements((v) => ({ ...v, duplicate: e.target.checked }))}
                  />
                  I reviewed the duplicate warning and still want to continue.
                </label>
              )}
              {beneficiaryChanged && (
                <label className="ack">
                  <input
                    type="checkbox"
                    checked={acknowledgements.beneficiary_changed}
                    onChange={(e) => setAcknowledgements((v) => ({ ...v, beneficiary_changed: e.target.checked }))}
                  />
                  I acknowledge the beneficiary-detail change.
                </label>
              )}
              {suspicious && (
                <label className="ack">
                  <input
                    type="checkbox"
                    checked={acknowledgements.suspicious}
                    onChange={(e) => setAcknowledgements((v) => ({ ...v, suspicious: e.target.checked }))}
                  />
                  I reviewed the suspicious-invoice warning.
                </label>
              )}
              <button
                className="primary wide"
                onClick={approve}
                disabled={
                  missing.length > 0 ||
                  (duplicateKnown && !acknowledgements.duplicate) ||
                  (beneficiaryChanged && !acknowledgements.beneficiary_changed) ||
                  (suspicious && !acknowledgements.suspicious)
                }
              >
                <ShieldCheck size={17}/> Approve exact payment
              </button>
              <small className="fine">Devnet-ready: real USDG moves only when the server devnet signer, mint and recipient are configured.</small>
            </div>
          </div>
        )}

        {stage === "settling" && (
          <div className="settlement">
            <span className="eyebrow">SOLANA SETTLEMENT</span>
            <h3>Executing approved payment</h3>
            {[
              "Approval locked",
              "USDG settlement submitted on Solana",
              "Settlement response confirmed",
              "Invoice reconciled"
            ].map((s, i) => (
              <div className={"settle-row " + (settleStep > i ? "complete" : settleStep === i ? "current" : "")} key={s}>
                <span>{settleStep > i ? <Check size={15}/> : i + 1}</span>
                <p>{s}</p>
              </div>
            ))}
          </div>
        )}

        {stage === "done" && (
          <div className="done">
            <div className="done-icon"><Check size={32}/></div>
            <span className="eyebrow">{settlement?.mode === "devnet" ? "DEVNET SETTLED" : "DEMO RECONCILED"}</span>
            <h2>Payment complete.</h2>
            <p>{result.supplier} is linked to the settlement record and the invoice now has an auditable payment state.</p>
            <div className="receipt">
              <div><span>Solana settlement</span><b>{settlement?.signature ? settlement.signature.slice(0, 12) + "…" : "Recorded"}</b></div>
              <div><span>Invoice</span><b>{fileName || analysis?.invoice_name || "invoice"}</b></div>
              <div><span>Mode</span><b>{settlement?.mode === "devnet" ? "Solana Devnet" : "Safe demo"}</b></div>
              <div><span>Status</span><b className="green">Matched ✓</b></div>
            </div>
            {settlement?.explorer && <a className="primary wide" href={settlement.explorer} target="_blank" rel="noreferrer" style={{textDecoration:"none",marginBottom:8}}>View on Solana Explorer <ArrowRight size={16}/></a>}
            <button className="secondary wide" onClick={close}>Back to dashboard</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelPreview() {
  const [channel, setChannel] = useState("WhatsApp");
  return (
    <section className="channel-section">
      <div className="section-head">
        <div>
          <span className="eyebrow">ONE OPERATOR · EVERYWHERE</span>
          <h2>Talk to 33jack where work already happens.</h2>
        </div>
        <div className="channel-tabs">
          {["WhatsApp","Telegram","WeChat","Web"].map((x) => <button key={x} className={channel === x ? "active" : ""} onClick={() => setChannel(x)}>{x}</button>)}
        </div>
      </div>
      <div className="channel-card">
        <div className="chat-head"><div className="avatar">33</div><div><b>33jack Agent</b><small>{channel} · Business account</small></div><span>online</span></div>
        <div className="chat-body">
          <div className="bubble user">Check this supplier invoice and prepare payment if everything is safe.</div>
          <div className="attachment"><FileText size={18}/><span>NovaParts_0926.pdf<small>1.8 MB</small></span></div>
          <div className="bubble bot">
            <b>Review complete.</b><br/>
            Supplier verified. No duplicate found. I detected a beneficiary detail change and need your acknowledgement before payment.
          </div>
          <div className="bubble bot compact">
            <b>Payment proposal</b>
            <p>£4,850 → USDG/Solana → ¥42,000</p>
            <small>Estimated delivery: same business day</small>
          </div>
          <button className="chat-cta">Review securely <ChevronRight size={15}/></button>
        </div>
      </div>
    </section>
  );
}



function ChannelsWorkspace() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch("/api/health")
      .then(readApiResponse)
      .then((data) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

  const whatsapp = health?.channels?.whatsapp || {};
  const telegram = health?.channels?.telegram || {};
  const wechat = health?.channels?.wechat || {};
  const whatsappReady = Boolean(
    whatsapp.configured &&
    whatsapp.verifyTokenConfigured &&
    whatsapp.appSecretConfigured
  );
  const telegramReady = Boolean(
    telegram.configured &&
    telegram.webhookSecretConfigured
  );
  const wechatReady = Boolean(
    wechat.configured &&
    wechat.secureModeReady &&
    wechat.outboundMessagingReady
  );

  return (
    <section className="workspace-page unit-workspace">
      <div className="section-head">
        <div>
          <span className="eyebrow">33JACK CHANNEL LAYER</span>
          <h2>Telegram live. WeChat next. Same controlled finance operator.</h2>
        </div>
        <p>Messaging channels prepare and review work. Exact approval and money movement remain inside the controlled 33Jack execution flow.</p>
      </div>

      <div className="channel-integration-grid">
        <div className="card channel-integration live-panel">
          <div className="pay-form-head">
            <div><span className="eyebrow">WHATSAPP CLOUD API</span><h3>Invoice-to-review business channel</h3></div>
            <span className={"sandbox-badge " + (whatsappReady ? "live" : "")}>{whatsappReady ? "CONFIGURED" : "CODE READY"}</span>
          </div>
          <p>Users can send invoices, ask normal finance questions, use voice notes, and request a payment review directly in WhatsApp. 33Jack keeps the conversation workspace-scoped and hands any money movement into the same signed approval flow.</p>
          <div className="rail-badges">
            <span>PDF + JPG + PNG</span><span>AI chat</span><span>Voice notes</span><span>Risk review</span><span>Secure handoff</span><span>Meta webhook verification</span>
          </div>
          <div className="proposal-lines">
            <p><span>Cloud API credentials</span><b>{whatsapp.configured ? "Configured" : "Needed"}</b></p>
            <p><span>Webhook verify token</span><b>{whatsapp.verifyTokenConfigured ? "Configured" : "Needed"}</b></p>
            <p><span>App secret signature check</span><b>{whatsapp.appSecretConfigured ? "Configured" : "Needed"}</b></p>
            <p><span>Workspace AI agent</span><b>{whatsapp.agentConfigured ? "Ready" : "Needs Groq"}</b></p>
            <p><span>Voice-note transcription</span><b>{whatsapp.voiceTranscriptionConfigured ? "Ready" : "Needs Groq"}</b></p>
            <p><span>Graph API</span><b>{whatsapp.graphVersion || "v26.0"}</b></p>
            <p><span>Webhook endpoint</span><b>/api/agent?provider=whatsapp</b></p>
          </div>
        </div>

        <div className="card channel-integration">
          <div className="pay-form-head">
            <div><span className="eyebrow">WECHAT OFFICIAL ACCOUNT</span><h3>Secure business messaging channel</h3></div>
            <span className={"sandbox-badge " + (wechatReady ? "live" : "")}>{wechatReady ? "CONFIGURED" : "CODE READY"}</span>
          </div>
          <p>WeChat users can ask finance questions, send invoice images and voice commands, then open the same signed Review & Pay flow. Server callbacks support WeChat Token verification and secure EncodingAESKey mode.</p>
          <div className="rail-badges">
            <span>AI chat</span><span>Invoice images</span><span>Voice commands</span><span>AES secure mode</span><span>Review & Pay</span><span>Settlement receipts</span>
          </div>
          <div className="proposal-lines">
            <p><span>Callback token</span><b>{wechat.callbackTokenConfigured ? "Configured" : "Needed"}</b></p>
            <p><span>Official Account AppID</span><b>{wechat.appIdConfigured ? "Configured" : "Needed"}</b></p>
            <p><span>AppSecret</span><b>{wechat.appSecretConfigured ? "Configured" : "Needed"}</b></p>
            <p><span>EncodingAESKey</span><b>{wechat.encodingAesKeyConfigured ? "Configured" : "Needed"}</b></p>
            <p><span>Secure mode</span><b>{wechat.secureModeReady ? "Ready" : "Waiting"}</b></p>
            <p><span>Webhook endpoint</span><b>/api/agent?provider=wechat</b></p>
          </div>
        </div>

        <div className="card channel-integration">
          <div className="pay-form-head">
            <div><span className="eyebrow">TELEGRAM</span><h3>Existing live channel</h3></div>
            <span className={"sandbox-badge " + (telegramReady ? "live" : "")}>{telegramReady ? "CONFIGURED" : "CODE READY"}</span>
          </div>
          <p>Telegram remains the currently configured messaging channel while WeChat is connected.</p>
          <div className="rail-badges"><span>Invoice upload</span><span>Mini App review</span><span>Receipts</span></div>
        </div>
      </div>

      <ChannelPreview/>
    </section>
  );
}


function SubunitCards({ onOpen }) {
  return (
    <section className="subunit-section">
      <div className="section-head">
        <div>
          <span className="eyebrow">ONE AGENT · THREE OPERATING UNITS</span>
          <h2>33Jack routes the obligation to the right rail.</h2>
        </div>
        <p>Invoice intelligence sits in front. Stablecoin settlement or local-currency payout happens only after deterministic checks and explicit approval.</p>
      </div>
      <div className="subunit-grid">
        {subunits.map((unit) => {
          const Icon = unit.icon;
          return (
            <button className="subunit-card" key={unit.name} onClick={() => onOpen(unit.name)}>
              <div className="subunit-card-top">
                <span className="subunit-icon"><Icon size={20}/></span>
                <span className={"subunit-status " + (unit.status === "Devnet live" || unit.status === "Live" ? "live" : "")}>{unit.status}</span>
              </div>
              <span className="eyebrow">{unit.eyebrow}</span>
              <h3>{unit.name}</h3>
              <p>{unit.description}</p>
              <div className="subunit-bullets">
                {unit.bullets.map((item) => <span key={item}><Check size={12}/>{item}</span>)}
              </div>
              <div className="subunit-open">Open unit <ArrowRight size={14}/></div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SettlementNetworkWorkspace() {
  const [form, setForm] = useState({
    sourceCurrency: "USD",
    sourceAmount: 10000,
    destinationCurrency: "GBP",
    destinationCountry: "GB",
    priority: "balanced"
  });
  const [quote, setQuote] = useState(null);
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");

  const currencies = ["USD", "GBP", "EUR", "CNY", "INR"];
  const destinationCountry = {
    USD: "US",
    GBP: "GB",
    EUR: "EU",
    CNY: "CN",
    INR: "IN"
  };

  useEffect(() => {
    fetch("/api/settlement-health")
      .then(readApiResponse)
      .then((data) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

  function patch(key, value) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "destinationCurrency" ? { destinationCountry: destinationCountry[value] || "" } : {})
    }));
    setReceipt(null);
  }

  async function discoverRoutes(event) {
    event?.preventDefault?.();
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      const response = await fetch("/api/settlement-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          sourceAmount: Number(form.sourceAmount || 0),
          policy: {
            maxFeeBps: 100,
            minReliability: 0.97,
            maxSettlementSeconds: 600,
            preferredStablecoins: ["USDC"],
            fallbackEnabled: true
          }
        })
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Route discovery failed");
      setQuote(data);
    } catch (e) {
      setError(e.message || "Route discovery failed");
    } finally {
      setBusy(false);
    }
  }

  async function runDemo(routeId) {
    if (!quote) return;
    setExecuting(true);
    setError("");
    try {
      const response = await fetch("/api/settlement-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quote, routeId, approved: true })
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Demo execution failed");
      setReceipt(data);
    } catch (e) {
      setError(e.message || "Demo execution failed");
    } finally {
      setExecuting(false);
    }
  }

  const recommended = quote?.recommendedRoute;
  const alternatives = quote?.alternativeRoutes || [];
  const networks = health?.networks || [
    { id: "solana", name: "Solana", mode: "devnet", status: "available", asset: "USDG / USDC" },
    { id: "morph", name: "Morph", mode: "demo", status: "demo", asset: "USDC" },
    { id: "base", name: "Base", mode: "demo", status: "demo", asset: "USDC" }
  ];
  const providers = health?.providers || [];
  const money = (amount, currency) => {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount || 0));
    } catch {
      return `${currency} ${Number(amount || 0).toLocaleString()}`;
    }
  };

  return (
    <section className="workspace-page settlement-workspace">
      <div className="settlement-hero">
        <div>
          <span className="eyebrow">33JACK SETTLEMENT NETWORK · DEMO</span>
          <h2>Intelligent routing across chains, liquidity and payout rails.</h2>
          <p>Specify the payment intent. 33JACK evaluates valid settlement paths, applies deterministic policy, scores the routes and recommends the best execution path.</p>
        </div>
        <div className="settlement-badge"><Globe2 size={18}/><span>Intent in</span><ArrowRight size={14}/><b>Best route out</b></div>
      </div>

      <div className="settlement-metrics">
        <Metric label="Networks" value={networks.length} sub="Solana · Morph · Base · Celo"/>
        <Metric label="Providers" value={providers.length || 3} sub="Adapter-based registry"/>
        <Metric label="Policy" value="Deterministic" sub="LLM cannot choose or sign"/>
        <Metric label="Execution" value="Demo-safe" sub="No customer funds move"/>
      </div>

      {error && <div className="pay-error">{error}</div>}

      <div className="settlement-grid">
        <form className="card settlement-intent" onSubmit={discoverRoutes}>
          <div className="pay-form-head">
            <div><span className="eyebrow">PAYMENT INTENT</span><h3>What must the recipient receive?</h3></div>
            <span className="mode-tag">DEMO</span>
          </div>

          <label>Source amount
            <div className="settlement-input-row">
              <select value={form.sourceCurrency} onChange={(e) => patch("sourceCurrency", e.target.value)}>
                {currencies.map((currency) => <option key={currency}>{currency}</option>)}
              </select>
              <input type="number" min="1" step="0.01" value={form.sourceAmount} onChange={(e) => patch("sourceAmount", e.target.value)}/>
            </div>
          </label>

          <label>Recipient currency
            <select value={form.destinationCurrency} onChange={(e) => patch("destinationCurrency", e.target.value)}>
              {currencies.filter((currency) => currency !== form.sourceCurrency).map((currency) => <option key={currency}>{currency}</option>)}
            </select>
          </label>

          <label>Priority
            <select value={form.priority} onChange={(e) => patch("priority", e.target.value)}>
              <option value="balanced">Balanced</option>
              <option value="cheapest">Cheapest</option>
              <option value="fastest">Fastest</option>
              <option value="reliability">Highest reliability</option>
              <option value="best_fx">Best FX</option>
            </select>
          </label>

          <div className="settlement-policy">
            <span><ShieldCheck size={15}/> Max fee 1.00%</span>
            <span><BadgeCheck size={15}/> Min reliability 97%</span>
            <span><Clock3 size={15}/> Max ETA 10 min</span>
            <span><RefreshCw size={15}/> Safe fallback enabled</span>
          </div>

          <button className="primary wide" type="submit" disabled={busy}>
            <RefreshCw size={16}/>{busy ? " Discovering routes…" : " Discover settlement routes"}
          </button>
        </form>

        <div className="card settlement-recommendation">
          {!recommended ? (
            <div className="settlement-empty">
              <Globe2 size={30}/>
              <span className="eyebrow">SMART ROUTER</span>
              <h3>Discover routes to see the settlement path.</h3>
              <p>33JACK compares network, provider, FX, fee, speed and reliability before recommending a path.</p>
            </div>
          ) : (
            <>
              <div className="pay-form-head">
                <div><span className="eyebrow">RECOMMENDED ROUTE</span><h3>{recommended.network.name} → {recommended.provider.name}</h3></div>
                <span className="route-score">{recommended.score}</span>
              </div>

              <div className="settlement-big">
                <small>Recipient receives</small>
                <strong>{money(recommended.destinationAmount, recommended.destinationCurrency)}</strong>
                <span>{money(recommended.estimatedTotalCost, recommended.sourceCurrency)} estimated total cost</span>
              </div>

              <div className="settlement-route-line">
                {recommended.steps.map((step, index) => (
                  <React.Fragment key={step.type + index}>
                    <div><small>{step.type}</small><b>{step.label}</b><em>{String(step.mode || "demo").toUpperCase()}</em></div>
                    {index < recommended.steps.length - 1 && <ArrowRight size={15}/>}
                  </React.Fragment>
                ))}
              </div>

              <div className="settlement-facts">
                <p><span>ETA</span><b>~{recommended.estimatedSettlementSeconds}s</b></p>
                <p><span>Reliability</span><b>{(recommended.reliabilityScore * 100).toFixed(2)}%</b></p>
                <p><span>FX spread</span><b>{recommended.fxSpreadBps} bps</b></p>
                <p><span>Policy</span><b>{recommended.policy.allowed ? "Passed" : "Blocked"}</b></p>
              </div>

              <div className="settlement-explain">{quote.explanation}</div>

              <button className="primary wide" type="button" onClick={() => runDemo(recommended.routeId)} disabled={executing}>
                <Zap size={16}/>{executing ? " Running demo…" : " Run demo settlement"}
              </button>
              <small className="demo-warning">Demo only — no customer funds, fiat or onchain assets move from this action.</small>
            </>
          )}
        </div>
      </div>

      {receipt && (
        <div className="card settlement-receipt">
          <div><span className="eyebrow">RECONCILED DEMO RECEIPT</span><h3>{receipt.receipt?.reference}</h3></div>
          <div className="settlement-timeline">
            {receipt.timeline?.map((event, index) => (
              <span key={event.status + index}><CheckCircle2 size={15}/><b>{event.status.replaceAll("_", " ")}</b>{event.detail && <small>{event.detail}</small>}</span>
            ))}
          </div>
          <p>{receipt.warning}</p>
        </div>
      )}

      <div className="settlement-lower-grid">
        <div className="card">
          <div className="pay-form-head"><div><span className="eyebrow">ALTERNATIVE ROUTES</span><h3>Policy-aware route comparison</h3></div><span>{alternatives.length}</span></div>
          <div className="settlement-alternatives">
            {alternatives.length ? alternatives.slice(0, 5).map((route) => (
              <div key={route.routeId} className={route.policy.allowed ? "settlement-alt" : "settlement-alt blocked"}>
                <span><b>{route.network.name} → {route.provider.name}</b><small>{route.stablecoin} · {route.mode.toUpperCase()}</small></span>
                <span><b>{money(route.estimatedTotalCost, route.sourceCurrency)}</b><small>~{route.estimatedSettlementSeconds}s</small></span>
                <span><b>{(route.reliabilityScore * 100).toFixed(2)}%</b><small>reliability</small></span>
                <span className="route-score">{route.score}</span>
              </div>
            )) : <div className="empty-records">Run route discovery to compare alternatives.</div>}
          </div>
        </div>

        <div className="card">
          <div className="pay-form-head"><div><span className="eyebrow">CONNECTED NETWORKS</span><h3>Adapter registry</h3></div><Globe2 size={18}/></div>
          <div className="settlement-network-list">
            {networks.map((network) => (
              <div key={network.id}>
                <span className="network-dot"/>
                <span><b>{network.name}</b><small>{network.asset}</small></span>
                <em className={"mode-tag " + network.mode}>{String(network.mode || network.status).toUpperCase()}</em>
              </div>
            ))}
          </div>
          <div className="settlement-provider-strip">
            {(providers.length ? providers : [
              { id: "wise", name: "Wise Sandbox", mode: "sandbox" },
              { id: "atlas", name: "Atlas Demo Rail", mode: "demo" },
              { id: "orbit", name: "Orbit Demo Rail", mode: "demo" }
            ]).map((provider) => <span key={provider.id}><b>{provider.name}</b><small>{provider.mode.toUpperCase()}</small></span>)}
          </div>
        </div>
      </div>

      <div className="card settlement-api">
        <div><span className="eyebrow">DEVELOPER API</span><h3>Intent → quote → execution</h3></div>
        <code>POST /api/settlement-quote</code>
        <ArrowRight size={15}/>
        <code>POST /api/settlement-execute</code>
        <ArrowRight size={15}/>
        <code>GET /api/settlement-health</code>
      </div>
    </section>
  );
}

function PayWorkspace({ seed }) {
  const [form, setForm] = useState({
    fundingAsset: "USDG",
    fundingAmount: "10000",
    destinationCurrency: "CNY",
    invoiceRef: "NXD-2026-1008",
    beneficiaryName: "Nexora Digital Co., Ltd.",
    bankName: "Bank of China, Shenzhen Branch",
    accountLast4: "5678",
    country: "China"
  });
  const [quote, setQuote] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [history, setHistory] = useState([]);
  const [historySearch, setHistorySearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [deletingPayoutId, setDeletingPayoutId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!seed?.id) return;
    const currency = String(seed.source_currency || seed.destination_currency || "USD").toUpperCase();
    setForm((current) => ({
      ...current,
      fundingAsset: "USDG",
      fundingAmount: String(seed.source_amount || ""),
      destinationCurrency: ["USD", "GBP", "CNY", "INR"].includes(currency) ? currency : "USD",
      invoiceRef: seed.invoice_number || seed.invoice_name || seed.id,
      beneficiaryName: seed.supplier || "",
      bankName: "",
      accountLast4: "",
      country: ""
    }));
    setQuote(null);
    setReceipt(null);
    setError("Invoice loaded. Complete the beneficiary bank fields before requesting the payout quote.");
  }, [seed?.id]);

  async function loadHistory() {
    try {
      const response = await fetch("/api/payments?kind=payouts&limit=8");
      const data = await readApiResponse(response);
      if (response.ok) setHistory(Array.isArray(data.payouts) ? data.payouts : []);
    } catch {
      // Keep the payout workspace usable if history is temporarily unavailable.
    }
  }

  useEffect(() => {
    loadHistory();
  }, []);

  function patch(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
    setQuote(null);
    setReceipt(null);
    setError("");
  }

  async function requestQuote(e) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      const response = await fetch("/api/payout-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payoutId: quote?.status === "quoted" ? quote.id : undefined,
          fundingAsset: form.fundingAsset,
          fundingAmount: Number(form.fundingAmount),
          destinationCurrency: form.destinationCurrency,
          invoiceRef: form.invoiceRef,
          beneficiary: {
            name: form.beneficiaryName,
            bank_name: form.bankName,
            account_last4: form.accountLast4,
            country: form.country
          }
        })
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Quote failed");
      setQuote(data.payout);
    } catch (e) {
      setError(e.message || "Quote failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshPayoutStatus(silent = false) {
    if (!quote?.id || trackingBusy) return;
    if (!silent) setTrackingBusy(true);
    try {
      const response = await fetch(`/api/payout-settle?payoutId=${encodeURIComponent(quote.id)}`);
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Status check failed");
      setQuote(data.payout || quote);
      if (data.receipt) setReceipt(data.receipt);
      await loadHistory();
      if (!silent) setError("");
    } catch (e) {
      if (!silent) setError(e.message || "Status check failed");
    } finally {
      if (!silent) setTrackingBusy(false);
    }
  }

  useEffect(() => {
    const provider = quote?.quote?.provider;
    const localStatus = String(quote?.status || "");
    const terminal = ["reconciled_external", "failed_external", "refunded_external"].includes(localStatus);
    if (!receipt || receipt.reconciled || provider !== "wise_sandbox" || terminal) return;

    const timer = setInterval(() => {
      refreshPayoutStatus(true);
    }, 12000);

    return () => clearInterval(timer);
  }, [quote?.id, quote?.status, quote?.quote?.provider, receipt?.reconciled]);

  async function approveAndPay() {
    if (!quote?.id || busy) return;
    setBusy(true);
    setError("");
    try {
      const approvalResponse = await fetch("/api/payout-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId: quote.id })
      });
      const approval = await readApiResponse(approvalResponse);
      if (!approvalResponse.ok) {
        if (approvalResponse.status === 409 && approval.refreshedPayout) {
          setQuote(approval.refreshedPayout);
          setError(approval.detail || "Quote changed. Review the refreshed terms before approving.");
          return;
        }
        throw new Error(approval.detail || approval.error || "Approval failed");
      }

      const settleResponse = await fetch("/api/payout-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalToken: approval.approvalToken })
      });
      const settlement = await readApiResponse(settleResponse);
      if (!settleResponse.ok) throw new Error(settlement.detail || settlement.error || "Payout failed");

      setReceipt(settlement.receipt || {
        id: settlement.payout?.receipt_id,
        status: "PAID (SANDBOX)",
        funding: `${settlement.payout?.funding_amount} ${settlement.payout?.funding_asset}`,
        delivered: `${settlement.payout?.destination_amount} ${settlement.payout?.destination_currency}`,
        beneficiary: settlement.payout?.beneficiary?.name,
        reconciled: true
      });
      setQuote(settlement.payout);
      await loadHistory();
    } catch (e) {
      setError(e.message || "Payout failed");
    } finally {
      setBusy(false);
    }
  }

  const q = quote?.quote || null;
  const destinationAmount = Number(quote?.destination_amount || q?.destinationAmount || 0);
  const fundingAmount = Number(quote?.funding_amount || q?.fundingAmount || 0);
  const feeAmount = Number(quote?.fee_amount || q?.feeAmount || 0);
  const exchangeRate = Number(quote?.exchange_rate || q?.exchangeRate || 0);
  const filteredHistory = history.filter((p) => {
    const beneficiary = typeof p.beneficiary === "string"
      ? (() => { try { return JSON.parse(p.beneficiary); } catch { return {}; } })()
      : (p.beneficiary || {});
    const haystack = [
      p.invoice_ref,
      p.id,
      beneficiary?.name,
      p.destination_currency,
      p.funding_asset,
      p.status,
      p.quote?.providerTransferId
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(historySearch.trim().toLowerCase());
  });

  async function removePayoutRecord(payout) {
    if (!payout?.id || deletingPayoutId) return;
    setDeletingPayoutId(String(payout.id));
    try {
      const result = await deleteStoredRecord(
        "payout",
        payout.id,
        `${payout.invoice_ref || payout.id} payout record`
      );
      if (result?.deleted) {
        setHistory((current) => current.filter((item) => String(item.id) !== String(payout.id)));
        if (String(quote?.id || "") === String(payout.id)) {
          setQuote(null);
          setReceipt(null);
        }
      }
    } finally {
      setDeletingPayoutId("");
    }
  }

  function exportPayoutCsv() {
    const rows = filteredHistory.map((p) => {
      const beneficiary = typeof p.beneficiary === "string"
        ? (() => { try { return JSON.parse(p.beneficiary); } catch { return {}; } })()
        : (p.beneficiary || {});
      return [
        p.invoice_ref || "",
        beneficiary?.name || "",
        p.funding_amount || "",
        p.funding_asset || "",
        p.destination_amount || "",
        p.destination_currency || "",
        p.quote?.partner || "",
        p.quote?.providerTransferId || "",
        p.status || "",
        p.updated_at || p.created_at || ""
      ];
    });
    const csv = [
      ["invoice_ref","beneficiary","funding_amount","funding_asset","destination_amount","destination_currency","provider","provider_transfer_id","status","updated_at"],
      ...rows
    ].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "33jack-payout-ledger.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="workspace-page unit-workspace">
      <div className="unit-hero">
        <div>
          <span className="eyebrow">33JACK PAY · STABLECOIN → FIAT</span>
          <h2>Fund in stablecoins. Deliver local currency.</h2>
          <p>33Jack builds the payout instruction, quotes FX and fees, binds approval to the exact beneficiary and amount, then runs the sandbox payout and reconciles the receipt.</p>
        </div>
        <div className="unit-flow">
          <span>USDG / USDC / USDT</span><ArrowRight/><span>33Jack controls</span><ArrowRight/><span>FX + payout adapter</span><ArrowRight/><span>Vendor bank</span>
        </div>
      </div>

      {error && <div className="pay-error">{error}</div>}

      <div className="pay-builder">
        <form className="card pay-form" onSubmit={requestQuote}>
          <div className="pay-form-head">
            <div><span className="eyebrow">PAYOUT INSTRUCTION</span><h3>Prepare vendor payout</h3></div>
            <span className="sandbox-badge">PROVIDER READY</span>
          </div>

          <div className="form-split">
            <label>Funding asset
              <select value={form.fundingAsset} onChange={(e) => patch("fundingAsset", e.target.value)}>
                <option>USDG</option><option>USDC</option><option>USDT</option>
              </select>
            </label>
            <label>Funding amount
              <input type="number" min="1" step="0.01" value={form.fundingAmount} onChange={(e) => patch("fundingAmount", e.target.value)}/>
            </label>
          </div>

          <div className="form-split">
            <label>Destination currency
              <select value={form.destinationCurrency} onChange={(e) => patch("destinationCurrency", e.target.value)}>
                <option>CNY</option><option>GBP</option><option>INR</option><option>USD</option>
              </select>
            </label>
            <label>Invoice reference
              <input value={form.invoiceRef} onChange={(e) => patch("invoiceRef", e.target.value)} placeholder="INV-2026-001"/>
            </label>
          </div>

          <div className="pay-divider">Beneficiary bank</div>
          <label>Beneficiary name
            <input value={form.beneficiaryName} onChange={(e) => patch("beneficiaryName", e.target.value)}/>
          </label>
          <label>Bank name
            <input value={form.bankName} onChange={(e) => patch("bankName", e.target.value)}/>
          </label>
          <div className="form-split">
            <label>Account last 4
              <input maxLength={4} value={form.accountLast4} onChange={(e) => patch("accountLast4", e.target.value.replace(/\D/g, "").slice(0,4))}/>
            </label>
            <label>Country
              <input value={form.country} onChange={(e) => patch("country", e.target.value)}/>
            </label>
          </div>

          <button className="primary wide" disabled={busy}>
            <RefreshCw size={16}/>{busy ? " Preparing…" : quote ? " Refresh quote" : " Get payout quote"}
          </button>
          <small className="fine">Sandbox only: this stage does not convert stablecoins or transmit fiat through a bank.</small>
        </form>

        <div className="card pay-quote">
          {!quote ? (
            <div className="pay-placeholder">
              <Landmark size={30}/>
              <span className="eyebrow">EXACT PAYOUT QUOTE</span>
              <h3>Route, FX, fee and received amount appear here.</h3>
              <p>The quote becomes immutable once approved. Any change requires a fresh quote.</p>
            </div>
          ) : receipt ? (
            <div className="pay-receipt">
              <div className="done-icon"><Check size={30}/></div>
              <span className="eyebrow">{receipt.reconciled ? "PAYOUT RECONCILED" : "PAYOUT SUBMITTED"}</span>
              <h3>{receipt.status}</h3>
              <div className="receipt">
                <div><span>Receipt</span><b>{receipt.id}</b></div>
                <div><span>Funding</span><b>{receipt.funding}</b></div>
                <div><span>Delivered</span><b>{receipt.delivered}</b></div>
                <div><span>Beneficiary</span><b>{receipt.beneficiary}</b></div>
                <div><span>Bank</span><b>{receipt.bank || form.bankName}</b></div>
                <div><span>Status</span><b className="green">{receipt.reconciled ? "Matched ✓" : (receipt.provider_status || "Provider tracking")}</b></div>
                {receipt.provider && <div><span>Provider</span><b>{receipt.provider}</b></div>}
              </div>
              {!receipt.reconciled && receipt.provider === "Wise Sandbox" && (
                <button type="button" className="secondary wide" onClick={() => refreshPayoutStatus(false)} disabled={trackingBusy}>
                  <RefreshCw size={16}/>{trackingBusy ? " Checking Wise…" : " Check Wise status"}
                </button>
              )}
              <p className="sandbox-note">
                {receipt.reconciled
                  ? "Wise reported the payout as sent. 33Jack reconciled the provider receipt automatically."
                  : receipt.provider === "Wise Sandbox"
                    ? "33Jack is tracking this Wise Sandbox transfer automatically. Sandbox transfers do not move real money."
                    : "This receipt proves the 33Jack approval → payout adapter → reconciliation workflow. No real fiat was transmitted."}
              </p>
            </div>
          ) : (
            <>
              <div className="pay-form-head">
                <div><span className="eyebrow">EXACT PAYOUT QUOTE</span><h3>{quote.beneficiary?.name}</h3></div>
                <span className="sandbox-badge">15 MIN QUOTE</span>
              </div>
              <div className="pay-big-amount">
                <small>Vendor receives</small>
                <strong>{destinationAmount.toLocaleString(undefined, {maximumFractionDigits:2})} {quote.destination_currency}</strong>
              </div>
              <div className="proposal-lines">
                <p><span>You fund</span><b>{fundingAmount.toLocaleString()} {quote.funding_asset}</b></p>
                <p><span>Reference FX</span><b>1 USD = {exchangeRate} {quote.destination_currency}</b></p>
                <p><span>Service + FX</span><b>{feeAmount.toFixed(2)} {quote.funding_asset}</b></p>
                <p><span>Delivery target</span><b>{q?.eta || "same business day"}</b></p>
                <p><span>Provider</span><b>{q?.partner || "33Jack Sandbox Payout Rail"}</b></p>
                <p><span>Bank</span><b>{quote.beneficiary?.bank_name} · ••••{quote.beneficiary?.account_last4}</b></p>
                <p><span>Invoice</span><b>{quote.invoice_ref || "No reference"}</b></p>
              </div>
              <div className="route">
                <span>{quote.funding_asset}</span><ArrowRight/><span>33Jack</span><ArrowRight/><span>{quote.destination_currency}</span><ArrowRight/><span>Bank</span>
              </div>
              <button type="button" className="primary wide" onClick={approveAndPay} disabled={busy}>
                <ShieldCheck size={16}/>{busy ? " Processing…" : " Approve exact payout"}
              </button>
              <small className="fine">Approval is HMAC-bound to funding amount, FX quote, fee, destination amount and beneficiary.</small>
            </>
          )}
        </div>
      </div>

      <div className="card payout-history">
        <div className="card-head">
          <div><span className="eyebrow">33JACK PAY LEDGER</span><h3>Recent fiat payout tests</h3></div>
          <div className="ledger-tools">
            <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="Search ledger"/>
            <button type="button" className="secondary" onClick={exportPayoutCsv} disabled={!filteredHistory.length}>Export CSV</button>
            <span className="sandbox-badge">NEON PERSISTED</span>
          </div>
        </div>
        {filteredHistory.length ? filteredHistory.map((p) => {
          let beneficiary = p.beneficiary || {};
          if (typeof beneficiary === "string") {
            try { beneficiary = JSON.parse(beneficiary); } catch { beneficiary = {}; }
          }
          return (
            <div className="payout-history-row" key={p.id}>
              <span><b>{beneficiary?.name || "Beneficiary"}</b><small>{p.invoice_ref || p.id}</small></span>
              <span><b>{Number(p.funding_amount).toLocaleString()} {p.funding_asset}</b><small>funding</small></span>
              <span><b>{Number(p.destination_amount).toLocaleString()} {p.destination_currency}</b><small>{p.quote?.partner || "33Jack payout rail"}</small></span>
              <span className="status-raw">
                {String(p.status || "").replaceAll("_", " ")}
                {p.quote?.providerTransferId ? <small> · #{p.quote.providerTransferId}</small> : null}
              </span>
              <button
                type="button"
                className="record-delete"
                onClick={() => removePayoutRecord(p)}
                disabled={deletingPayoutId === String(p.id)}
                aria-label={`Delete payout ${p.invoice_ref || p.id}`}
              >
                <Trash2 size={14}/><span>{deletingPayoutId === String(p.id) ? "Deleting…" : "Delete"}</span>
              </button>
            </div>
          );
        }) : <div className="empty-records">No fiat payout simulations yet.</div>}
      </div>
    </section>
  );
}


function CryptoWorkspace({ onNewPayment, seed }) {
  return (
    <section className="workspace-page unit-workspace">
      <div className="unit-hero">
        <div>
          <span className="eyebrow">33JACK CRYPTO · STABLECOIN → STABLECOIN</span>
          <h2>Stablecoin payouts for vendors, contractors and crypto-native teams.</h2>
          <p>Upload the obligation, verify the destination wallet, approve the exact payment and settle with an auditable onchain receipt.</p>
          {seed && <div className="pay-success">Loaded {seed.invoice_number || seed.id} · {seed.supplier} · {seed.source_currency} {Number(seed.source_amount || 0).toLocaleString()}</div>}
          <button className="primary" onClick={onNewPayment}><Coins size={16}/>{seed ? " Continue invoice payment" : " New stablecoin payment"}</button>
        </div>
        <div className="unit-flow">
          <span>Invoice</span><ArrowRight/><span>Risk + approval</span><ArrowRight/><span>USDG</span><ArrowRight/><span>Solana wallet</span>
        </div>
      </div>
      <div className="unit-panels">
        <div className="card unit-panel live-panel">
          <span className="eyebrow">LIVE DEVNET RAIL</span>
          <h3>USDG · Solana Token-2022</h3>
          <p>Server-side signer, exact approval binding, transaction signature persistence and reconciliation are already implemented.</p>
          <div className="rail-badges"><span>USDG</span><span>Solana Devnet</span><span>Token-2022</span><span>Explorer proof</span></div>
        </div>
        <div className="card unit-panel">
          <span className="eyebrow">NEXT ASSETS</span>
          <h3>Keep the treasury stablecoin-only.</h3>
          <p>USDC and USDT can be added behind the same settlement interface without turning 33Jack into a general volatile-crypto payment app.</p>
        </div>
      </div>
    </section>
  );
}

function InvoiceWorkspace({ onNewPayment, onUseInvoice }) {
  const [draft, setDraft] = useState({
    supplier: "Nova Systems Ltd",
    customer: "Mushee Labs",
    amount: "5000",
    currency: "USD",
    dueDate: "2026-10-10",
    description: "Engineering services"
  });
  const [invoiceNumber] = useState(() => "33J-" + Date.now().toString(36).toUpperCase());
  const [saved, setSaved] = useState(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState("");
  const total = Number(draft.amount || 0);

  async function saveInvoice() {
    if (invoiceBusy) return null;
    setInvoiceBusy(true);
    setInvoiceError("");
    try {
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "invoice",
          id: saved?.id,
          invoiceNumber,
          supplier: draft.supplier,
          customer: draft.customer,
          amount: total,
          currency: draft.currency,
          dueDate: draft.dueDate,
          description: draft.description
        })
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Invoice save failed");
      setSaved(data.invoice);
      return data.invoice;
    } catch (e) {
      setInvoiceError(e.message || "Invoice save failed");
      return null;
    } finally {
      setInvoiceBusy(false);
    }
  }

  async function useInPaymentFlow() {
    const invoice = saved || await saveInvoice();
    if (invoice) {
      if (onUseInvoice) onUseInvoice(invoice);
      else onNewPayment?.();
    }
  }

  function printInvoice() {
    const popup = window.open("", "_blank", "width=820,height=900");
    if (!popup) {
      setInvoiceError("Your browser blocked the invoice print window.");
      return;
    }
    const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
    popup.document.write(`<!doctype html><html><head><title>${safe(invoiceNumber)}</title>
      <style>
        body{font-family:Arial,sans-serif;margin:48px;color:#111} .top{display:flex;justify-content:space-between;align-items:flex-start}
        h1{font-size:42px;margin:0 0 24px} .muted{color:#666} .party{margin:28px 0}
        .line,.total{display:flex;justify-content:space-between;padding:16px 0;border-bottom:1px solid #ddd}
        .total{font-size:24px;font-weight:700;border-top:2px solid #111;margin-top:20px}
        .note{margin-top:36px;font-size:12px;color:#666}
      </style></head><body>
      <div class="top"><div><strong>33JACK INVOICE</strong><div class="muted">Payment-ready business instruction</div></div><div><strong>${safe(invoiceNumber)}</strong></div></div>
      <h1>INVOICE</h1>
      <div class="party"><div class="muted">FROM</div><strong>${safe(draft.supplier)}</strong></div>
      <div class="party"><div class="muted">BILL TO</div><strong>${safe(draft.customer)}</strong></div>
      <div class="line"><span>${safe(draft.description)}</span><strong>${safe(draft.currency)} ${safe(total.toLocaleString())}</strong></div>
      <div class="total"><span>TOTAL DUE</span><span>${safe(draft.currency)} ${safe(total.toLocaleString())}</span></div>
      <p>Due: <strong>${safe(draft.dueDate)}</strong></p>
      <div class="note">Generated by 33Jack. Payment still requires verified beneficiary details and explicit approval.</div>
      <script>window.onload=()=>window.print();<\/script></body></html>`);
    popup.document.close();
  }

  return (
    <section className="workspace-page unit-workspace">
      <div className="section-head">
        <div><span className="eyebrow">33JACK INVOICE</span><h2>Create a payment-ready invoice.</h2></div>
        <p>Create, persist, print/save as PDF, and feed the instruction back into the controlled payment workflow.</p>
      </div>
      {invoiceError && <div className="pay-error">{invoiceError}</div>}
      {saved && <div className="pay-success">Invoice {saved.invoice_number} saved to the 33Jack ledger.</div>}
      <div className="invoice-builder">
        <div className="card invoice-form">
          <label>Supplier<input value={draft.supplier} onChange={(e) => { setDraft({...draft, supplier:e.target.value}); setSaved(null); }}/></label>
          <label>Bill to<input value={draft.customer} onChange={(e) => { setDraft({...draft, customer:e.target.value}); setSaved(null); }}/></label>
          <div className="form-split">
            <label>Amount<input type="number" min="0.01" step="0.01" value={draft.amount} onChange={(e) => { setDraft({...draft, amount:e.target.value}); setSaved(null); }}/></label>
            <label>Currency<select value={draft.currency} onChange={(e) => { setDraft({...draft, currency:e.target.value}); setSaved(null); }}><option>USD</option><option>GBP</option><option>CNY</option><option>INR</option><option>USDC</option><option>USDG</option><option>USDT</option></select></label>
          </div>
          <label>Due date<input type="date" value={draft.dueDate} onChange={(e) => { setDraft({...draft, dueDate:e.target.value}); setSaved(null); }}/></label>
          <label>Description<textarea value={draft.description} onChange={(e) => { setDraft({...draft, description:e.target.value}); setSaved(null); }}/></label>
          <div className="invoice-actions">
            <button className="secondary" type="button" onClick={saveInvoice} disabled={invoiceBusy}><FileCheck2 size={15}/>{invoiceBusy ? " Saving…" : " Save invoice"}</button>
            <button className="secondary" type="button" onClick={printInvoice}><ReceiptText size={15}/> Print / Save PDF</button>
            <button className="primary" type="button" onClick={useInPaymentFlow} disabled={invoiceBusy}><ArrowRight size={15}/> Use in payment flow</button>
          </div>
        </div>
        <div className="invoice-preview">
          <div className="invoice-preview-head"><Logo/><span>{saved ? "SAVED" : "PAYMENT-READY"}</span></div>
          <div className="invoice-preview-title"><span>INVOICE</span><b>{invoiceNumber}</b></div>
          <div className="invoice-party"><small>FROM</small><strong>{draft.supplier || "Supplier"}</strong></div>
          <div className="invoice-party"><small>BILL TO</small><strong>{draft.customer || "Customer"}</strong></div>
          <div className="invoice-line"><span>{draft.description || "Services"}</span><b>{draft.currency} {total.toLocaleString()}</b></div>
          <div className="invoice-total"><span>TOTAL DUE</span><strong>{draft.currency} {total.toLocaleString()}</strong></div>
          <div className="invoice-meta"><span>Due {draft.dueDate || "—"}</span><span>33Jack tag · {invoiceNumber}</span></div>
          <div className="invoice-note">Generated as a structured payment instruction. Settlement still requires beneficiary verification and explicit approval.</div>
        </div>
      </div>
    </section>
  );
}


function VoicePayWorkspace() {
  const [phase, setPhase] = useState("idle");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState(null);
  const [listening, setListening] = useState(false);
  const [processingVoice, setProcessingVoice] = useState(false);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const stopTimerRef = useRef(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([
    { role: "agent", text: 'Say “Pay Jonathan Berger” to start.' }
  ]);
  const [reference, setReference] = useState(
    () => "VOICE-" + Date.now().toString(36).toUpperCase()
  );

  function speak(text) {
    try {
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Voice playback is optional; the on-screen transcript remains authoritative.
    }
  }

  function addMessage(role, text) {
    setMessages((current) => [...current, { role, text }]);
  }

  function wordsToNumber(text) {
    const normalized = String(text || "")
      .toLowerCase()
      .replace(/[$£€,]/g, " ")
      .replace(/\b(us|u\.s\.)?\s*dollars?\b/g, " ")
      .replace(/\bgrand\b/g, " thousand ")
      .replace(/-/g, " ")
      .trim();

    const numeric = normalized.match(/\d+(?:\.\d+)?/);
    if (numeric) return Number(numeric[0]);

    const small = {
      zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
      fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
      nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
      seventy: 70, eighty: 80, ninety: 90
    };

    let total = 0;
    let current = 0;
    let sawNumberWord = false;
    for (const word of normalized.split(/\s+/)) {
      if (word === "and") continue;
      if (Object.prototype.hasOwnProperty.call(small, word)) {
        current += small[word];
        sawNumberWord = true;
      } else if (word === "hundred") {
        current = Math.max(current, 1) * 100;
        sawNumberWord = true;
      } else if (word === "thousand") {
        total += Math.max(current, 1) * 1000;
        current = 0;
        sawNumberWord = true;
      } else if (word === "million") {
        total += Math.max(current, 1) * 1000000;
        current = 0;
        sawNumberWord = true;
      }
    }

    return sawNumberWord ? total + current : NaN;
  }

  function formatUsd(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  }

  function handleIntent(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return;

    setError("");
    addMessage("user", text);

    const payMatch = text.match(/^pay\s+(.+?)(?:\s+(?:please|now))?$/i);
    if (payMatch) {
      const name = payMatch[1].trim();
      setRecipient(name);
      setAmount(null);
      setPhase("amount");
      const reply = "How much?";
      addMessage("agent", reply);
      speak(reply);
      return;
    }

    if (phase === "amount") {
      const parsed = wordsToNumber(text);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const reply = "I did not catch the amount. Try saying two thousand dollars.";
        addMessage("agent", reply);
        speak(reply);
        return;
      }
      setAmount(parsed);
      setPhase("confirm");
      const reply = formatUsd(parsed) + " to " + recipient + ". Say confirm invoice.";
      addMessage("agent", reply);
      speak(reply);
      return;
    }

    if (phase === "confirm" && /\b(confirm|confirm invoice|yes)\b/i.test(text)) {
      setPhase("approve");
      const reply = "Invoice ready. Review it on screen, then approve to send.";
      addMessage("agent", reply);
      speak(reply);
      return;
    }

    if (phase === "approve" && /\bapprove\b/i.test(text)) {
      const reply = "Use the Approve and send button on screen. Voice alone cannot release a payment.";
      addMessage("agent", reply);
      speak(reply);
      return;
    }

    const reply =
      phase === "idle"
        ? 'Start with “Pay Jonathan Berger”.'
        : phase === "amount"
          ? "Tell me the amount."
          : phase === "confirm"
            ? 'Say “confirm invoice”.'
            : phase === "approve"
              ? "Review the invoice and approve it on screen."
              : "The beta payment is complete. Reset to start another.";
    addMessage("agent", reply);
    speak(reply);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || "");
        resolve(value.includes(",") ? value.split(",")[1] : value);
      };
      reader.onerror = () => reject(new Error("Could not read microphone recording"));
      reader.readAsDataURL(blob);
    });
  }

  async function transcribeVoice(blob) {
    setProcessingVoice(true);
    setError("");
    try {
      if (!blob || blob.size < 200) {
        throw new Error("The recording was empty. Try again and speak after the mic turns green.");
      }

      const audioData = await blobToBase64(blob);
      const response = await fetch("/api/agent?provider=voice-transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioData,
          mimeType: blob.type || "audio/webm"
        })
      });
      const data = await readApiResponse(response);
      if (!response.ok) {
        throw new Error(data.detail || data.error || "Voice transcription failed");
      }

      const transcript = String(data.transcript || "").trim();
      if (!transcript) {
        throw new Error("I could not hear a command in that recording. Try again.");
      }
      handleIntent(transcript);
    } catch (voiceError) {
      setError(voiceError instanceof Error ? voiceError.message : "Voice transcription failed. Try again.");
    } finally {
      setProcessingVoice(false);
    }
  }

  async function listen() {
    if (processingVoice) return;

    const activeRecorder = recorderRef.current;
    if (listening && activeRecorder && activeRecorder.state === "recording") {
      activeRecorder.stop();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record microphone audio. Use Chrome, Edge, Safari, or type the command below.");
      return;
    }

    try {
      setError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      streamRef.current = stream;

      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4"
      ];
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        setError("The microphone recording failed. Check browser microphone permission and try again.");
      };

      recorder.onstop = async () => {
        if (stopTimerRef.current) {
          clearTimeout(stopTimerRef.current);
          stopTimerRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setListening(false);

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm"
        });
        chunksRef.current = [];
        await transcribeVoice(blob);
      };

      recorder.start();
      setListening(true);

      stopTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 8000);
    } catch (voiceError) {
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setListening(false);

      const name = voiceError?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Microphone access is blocked. Allow microphone access for 33jack.vercel.app, then tap the mic again.");
      } else if (name === "NotFoundError") {
        setError("No microphone was detected on this device.");
      } else if (name === "NotReadableError") {
        setError("The microphone is busy or unavailable. Close any app using it and try again.");
      } else {
        setError(voiceError instanceof Error ? voiceError.message : "Could not start the microphone.");
      }
    }
  }

  function submitTyped(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    handleIntent(text);
  }

  function approveAndSend() {
    if (!recipient || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      setError("Recipient and amount are required before approval.");
      return;
    }
    setPhase("sent");
    const reply = "Sent.";
    addMessage("agent", reply);
    speak(reply);
  }

  function reset() {
    setPhase("idle");
    setRecipient("");
    setAmount(null);
    setReference("VOICE-" + Date.now().toString(36).toUpperCase());
    setError("");
    setInput("");
    setMessages([{ role: "agent", text: 'Say “Pay Jonathan Berger” to start.' }]);
  }

  const showInvoice = ["approve", "sent"].includes(phase);

  return (
    <section className="workspace-page voice-pay-workspace">
      <div className="section-head">
        <div>
          <span className="eyebrow">VOICE PAY · BETA</span>
          <h2>Say the payment. 33Jack builds the instruction.</h2>
        </div>
        <div className="voice-beta-badge">BETA · NO REAL FUNDS</div>
      </div>

      <div className="voice-beta-grid">
        <div className="card voice-console">
          <div className="voice-orb-wrap">
            <button
              type="button"
              className={listening ? "voice-orb listening" : "voice-orb"}
              onClick={listen}
              disabled={processingVoice}
              aria-label={listening ? "Stop voice command recording" : "Start voice command"}
            >
              <Mic size={28}/>
            </button>
            <div>
              <span className="eyebrow">{processingVoice ? "TRANSCRIBING…" : listening ? "LISTENING…" : "VOICE COMMAND"}</span>
              <h3>{processingVoice ? "Understanding command…" : listening ? "Speak now. Tap again when done." : "Tap the mic and speak."}</h3>
              <p>Example: “Pay Jonathan Berger” → “Two thousand dollars” → “Confirm invoice”.</p>
            </div>
          </div>

          {error && <div className="pay-error">{error}</div>}

          <div className="voice-transcript">
            {messages.map((message, index) => (
              <div key={index} className={"voice-message " + message.role}>
                <span>{message.role === "agent" ? <Volume2 size={14}/> : "YOU"}</span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>

          <form className="voice-command-form" onSubmit={submitTyped}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Type a command, e.g. "Pay Jonathan Berger"'
            />
            <button className="secondary" type="submit"><Send size={15}/> Send</button>
          </form>
        </div>

        <div className="card voice-invoice-card">
          {!showInvoice ? (
            <div className="pay-placeholder">
              <ReceiptText size={30}/>
              <span className="eyebrow">VOICE-GENERATED INVOICE</span>
              <h3>The invoice appears after you confirm the instruction.</h3>
              <p>33Jack will not send anything from voice alone. The final release stays behind explicit approval.</p>
            </div>
          ) : (
            <>
              <div className="voice-invoice-head">
                <div>
                  <span className="eyebrow">CONFIRM INVOICE</span>
                  <h3>{recipient}</h3>
                </div>
                <span className={phase === "sent" ? "pill good" : "sandbox-badge"}>
                  {phase === "sent" ? "SENT · BETA" : "AWAITING APPROVAL"}
                </span>
              </div>

              <div className="voice-amount">
                <small>Payment amount</small>
                <strong>{formatUsd(amount)}</strong>
              </div>

              <div className="receipt voice-receipt">
                <div><span>Recipient</span><b>{recipient}</b></div>
                <div><span>Amount</span><b>{formatUsd(amount)}</b></div>
                <div><span>Currency</span><b>USD</b></div>
                <div><span>Reference</span><b>{reference}</b></div>
                <div><span>Origin</span><b>Voice instruction</b></div>
                <div><span>Mode</span><b>33Jack Voice Pay Beta</b></div>
              </div>

              {phase === "approve" ? (
                <button type="button" className="primary wide" onClick={approveAndSend}>
                  <ShieldCheck size={16}/> Approve & send beta payment
                </button>
              ) : (
                <div className="voice-sent-state">
                  <CheckCircle2 size={22}/>
                  <div><b>Sent.</b><small>Beta simulation complete. No real funds were moved.</small></div>
                </div>
              )}

              <button type="button" className="secondary wide" onClick={reset}>
                Start another voice payment
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}


function JackSwipeWorkspace({ payments = [], onRefresh, onReview }) {
  const demoInvoice = useMemo(() => ({
    id: "jack-swipe-demo",
    demo: true,
    supplier: "Heatin Strategy",
    invoice_number: "HS-2048",
    source_currency: "USD",
    source_amount: 2000,
    destination_currency: "USD",
    destination_amount: "$2,000",
    route: "USD → USDG/Solana → USD",
    risk: { duplicate: false, beneficiary_changed: false, suspicious: false, missing_fields: [] }
  }), []);

  const [queue, setQueue] = useState([]);
  const [swipe, setSwipe] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Swipe right when you are ready to approve this invoice.");
  const [receipt, setReceipt] = useState(null);
  const [reviewPayment, setReviewPayment] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const eligible = (Array.isArray(payments) ? payments : [])
      .filter((payment) => String(payment?.status || "").toLowerCase() === "analyzed")
      .slice(0, 8);

    setQueue((current) => {
      const realCurrent = current.filter((item) => !item.demo);
      if (eligible.length) return eligible;
      if (realCurrent.length) return realCurrent;
      return [demoInvoice];
    });
  }, [payments, demoInvoice]);

  const current = queue[0] || null;

  function paymentAmount(payment) {
    if (!payment) return "—";
    if (payment.source_amount && payment.source_currency) {
      return formatMoney(payment.source_amount, payment.source_currency);
    }
    return payment.destination_amount || "Amount pending";
  }

  function textToBase64(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function hasRiskBlock(payment) {
    const risk = payment?.risk || {};
    return Boolean(
      risk.duplicate ||
      risk.beneficiary_changed ||
      risk.suspicious ||
      (Array.isArray(risk.missing_fields) && risk.missing_fields.length)
    );
  }

  async function materialiseDemoInvoice() {
    const source = `INVOICE JACK-SWIPE-BETA-HS-2048
Supplier: Heatin Strategy
Invoice number: HS-2048
Amount due: USD 2000
Target payout currency: USD
Due: 16 October 2026
Beneficiary details: beta account ending 2048
This invoice is a Jack Swipe beta demonstration.`;

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "heatin-strategy-HS-2048.txt",
        mimeType: "text/plain",
        fileData: textToBase64(source),
        corridor: "USD"
      })
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.detail || data.error || "Could not prepare the beta invoice");
    return data;
  }

  async function runSwipePayment(approvedSwipe = swipe) {
    if (!current || busy || Number(approvedSwipe) < 92) return;

    setBusy(true);
    setError("");
    setReceipt(null);
    setReviewPayment(null);

    try {
      setStatus("33Jack agent is verifying the invoice…");
      let payment = current.demo ? await materialiseDemoInvoice() : current;

      if (hasRiskBlock(payment)) {
        setReviewPayment(payment);
        setStatus("This invoice needs a risk review before money can move.");
        setSwipe(0);
        return;
      }

      setStatus("Swipe accepted. Binding your approval to the exact payment…");
      const approvalResponse = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: payment.id,
          acknowledgements: {},
          amountUsdg: 1
        })
      });
      const approval = await readApiResponse(approvalResponse);
      if (!approvalResponse.ok) {
        if (/acknowledg|risk|duplicate|beneficiary|suspicious/i.test(String(approval.detail || approval.error || ""))) {
          setReviewPayment(payment);
          setStatus("33Jack stopped the swipe because this invoice needs explicit risk review.");
          setSwipe(0);
          return;
        }
        throw new Error(approval.detail || approval.error || "Swipe approval failed");
      }

      setStatus("Approved. 33Jack is executing the beta settlement…");
      const settlementResponse = await fetch("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalToken: approval.approvalToken })
      });
      const settlement = await readApiResponse(settlementResponse);
      if (!settlementResponse.ok) {
        throw new Error(settlement.detail || settlement.error || "Settlement failed");
      }

      const completed = {
        supplier: payment.supplier || "Supplier",
        invoice: payment.invoice_number || payment.invoice_name || payment.id,
        amount: paymentAmount(payment),
        route: payment.route || payment.recommended_route || "33Jack settlement route",
        mode: settlement.mode || approval.mode || "beta",
        reference: settlement.signature || settlement.transactionSignature || settlement.id || payment.id,
        explorerUrl: settlement.explorerUrl || settlement.explorer_url || null,
        status: settlement.status || "completed"
      };

      setReceipt(completed);
      setStatus("Completed. Receipt ready.");
      setQueue((items) => items.slice(1));
      setSwipe(100);
      await onRefresh?.();
    } catch (e) {
      setError(e.message || "Jack Swipe could not complete this payment.");
      setStatus("Payment stopped. Nothing else will be attempted until you retry.");
      setSwipe(0);
    } finally {
      setBusy(false);
    }
  }

  function resetForNext() {
    setReceipt(null);
    setReviewPayment(null);
    setError("");
    setSwipe(0);
    setStatus("Swipe right when you are ready to approve this invoice.");
  }

  return (
    <section className="workspace-page jack-swipe-workspace">
      <div className="section-head">
        <div>
          <span className="eyebrow">JACK SWIPE · BETA</span>
          <h2>Invoice pops up. Swipe it. Jack handles the payment work.</h2>
        </div>
        <div className="voice-beta-badge">BETA · CONTROLLED EXECUTION</div>
      </div>

      <div className="jack-swipe-grid">
        <div className="card jack-swipe-stage">
          <div className="swipe-notification">
            <div className="swipe-notification-icon"><ReceiptText size={18}/></div>
            <div>
              <span className="eyebrow">INVOICE READY</span>
              <b>{current ? `Pay invoice to ${current.supplier || "supplier"}` : "No invoice waiting"}</b>
              <small>{current ? `${current.invoice_number || current.invoice_name || current.id} · ${paymentAmount(current)}` : "33Jack will surface the next eligible invoice here."}</small>
            </div>
            <span className="swipe-live-dot" />
          </div>

          {error && <div className="pay-error">{error}</div>}

          {receipt ? (
            <div className="jack-swipe-complete">
              <div className="done-icon"><Check size={30}/></div>
              <span className="eyebrow">JACK SWIPE RECEIPT</span>
              <h3>Payment completed.</h3>
              <p>33Jack followed the swipe through approval, settlement and receipt creation.</p>
              <div className="receipt">
                <div><span>Supplier</span><b>{receipt.supplier}</b></div>
                <div><span>Invoice</span><b>{receipt.invoice}</b></div>
                <div><span>Amount</span><b>{receipt.amount}</b></div>
                <div><span>Route</span><b>{receipt.route}</b></div>
                <div><span>Mode</span><b>{receipt.mode}</b></div>
                <div><span>Reference</span><b>{String(receipt.reference || "Recorded").slice(0, 26)}</b></div>
              </div>
              {receipt.explorerUrl && (
                <a className="secondary wide swipe-receipt-link" href={receipt.explorerUrl} target="_blank" rel="noreferrer">
                  View settlement receipt <ArrowRight size={15}/>
                </a>
              )}
              <button type="button" className="primary wide" onClick={resetForNext}>
                Show next invoice
              </button>
            </div>
          ) : current ? (
            <div className="swipe-invoice-shell">
              <div className="swipe-invoice-top">
                <div>
                  <span className="eyebrow">PAY INVOICE TO</span>
                  <h3>{current.supplier || "Supplier"}</h3>
                </div>
                <span className="sandbox-badge">{current.demo ? "BETA DEMO" : "READY"}</span>
              </div>

              <div className="swipe-big-amount">
                <small>Amount due</small>
                <strong>{paymentAmount(current)}</strong>
              </div>

              <div className="receipt">
                <div><span>Invoice</span><b>{current.invoice_number || current.invoice_name || current.id}</b></div>
                <div><span>Route</span><b>{current.route || current.recommended_route || "Prepared by 33Jack"}</b></div>
                <div><span>Risk</span><b>{hasRiskBlock(current) ? "Review required" : "Eligible for swipe"}</b></div>
                <div><span>Action</span><b>Swipe = explicit approval</b></div>
              </div>

              {reviewPayment ? (
                <div className="swipe-review-stop">
                  <TriangleAlert size={18}/>
                  <div>
                    <b>Jack stopped this one for review.</b>
                    <small>Risk warnings cannot be silently acknowledged by a swipe.</small>
                  </div>
                  <button type="button" className="secondary" onClick={() => onReview?.(reviewPayment)}>
                    Open review
                  </button>
                </div>
              ) : (
                <div className={busy ? "swipe-control-wrap busy" : "swipe-control-wrap"}>
                  <div className="swipe-track-label">
                    <span>{busy ? "33Jack is working…" : swipe >= 92 ? "Release to pay" : "Swipe to pay invoice"}</span>
                    <ArrowRight size={17}/>
                  </div>
                  <input
                    id="jack-swipe-control"
                    data-testid="jack-swipe-control"
                    className="swipe-control"
                    type="range"
                    min="0"
                    max="100"
                    value={swipe}
                    disabled={busy}
                    aria-label="Swipe to pay invoice"
                    onChange={(e) => setSwipe(Number(e.target.value))}
                    onPointerUp={() => runSwipePayment(swipe)}
                    onTouchEnd={() => runSwipePayment(swipe)}
                    onKeyDown={(e) => {
                      if (e.key === "End") {
                        e.preventDefault();
                        setSwipe(100);
                        runSwipePayment(100);
                      } else if ((e.key === "Enter" || e.key === " ") && swipe >= 92) {
                        e.preventDefault();
                        runSwipePayment(swipe);
                      }
                    }}
                  />
                </div>
              )}

              <div className="swipe-agent-status">
                <Sparkles size={15}/>
                <span>{status}</span>
              </div>
              <small className="fine">
                Beta uses the existing 33Jack approval and settlement APIs. Flagged invoices stop for review; configured rails may execute Devnet/sandbox activity, not production bank payments.
              </small>
            </div>
          ) : (
            <div className="pay-placeholder">
              <CheckCircle2 size={30}/>
              <span className="eyebrow">ALL CLEAR</span>
              <h3>No eligible invoice is waiting.</h3>
              <p>When a clean analysed invoice arrives, Jack Swipe can surface it here for one-gesture approval.</p>
              <button type="button" className="secondary" onClick={onRefresh}><RefreshCw size={15}/> Refresh invoices</button>
            </div>
          )}
        </div>

        <div className="card jack-swipe-explainer">
          <span className="eyebrow">WHAT THE AGENT DOES AFTER THE SWIPE</span>
          <h3>One gesture. Full controlled workflow.</h3>
          <div className="swipe-agent-steps">
            <div><span>01</span><div><b>Lock invoice</b><small>Bind supplier, amount, route and payment ID.</small></div></div>
            <div><span>02</span><div><b>Check risk</b><small>Duplicates or beneficiary changes stop for review.</small></div></div>
            <div><span>03</span><div><b>Approve</b><small>Your swipe becomes the explicit human approval gesture.</small></div></div>
            <div><span>04</span><div><b>Settle</b><small>Reuse the existing server-side settlement adapter.</small></div></div>
            <div><span>05</span><div><b>Receipt</b><small>Return status, route and settlement reference immediately.</small></div></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentWorkspace({ onNewPayment, onCelo }) {
  const [messages, setMessages] = useState([
    { role: "agent", text: "Ask me about payment risk, failures, suppliers, or what needs attention. I am read-only here; money movement stays behind the structured approval flow." }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function askAgent(e) {
    e?.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail || data.error || "Agent failed");
      setMessages((m) => [...m, { role: "agent", text: data.answer, proposal: data.proposal || null }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "agent", text: "I could not read the finance state right now: " + (e.message || "unknown error") }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="workspace-page">
      <div className="section-head">
        <div>
          <span className="eyebrow">33JACK OPERATOR</span>
          <h2>Ask the business finance state.</h2>
        </div>
        <p>Read-only reasoning over stored payments, risk flags and beneficiary history. Execution stays in the controlled payment flow.</p>
      </div>
      <div className="agent-console card">
        <div className="agent-transcript">
          {messages.map((m, i) => (
            <div key={i} className={"operator-message " + m.role}>
              <span>{m.role === "agent" ? "33" : "YOU"}</span>
              <div>
                <p>{m.text}</p>
                {m.proposal && (
                  <div className="agent-proposal">
                    <b>{m.proposal.unit} · {m.proposal.invoice || m.proposal.paymentId}</b>
                    <small>{m.proposal.supplier || "Supplier"} · {m.proposal.route || "Route pending"}</small>
                    {m.proposal.blockers?.length ? (
                      <small>Blockers: {m.proposal.blockers.join(", ")}</small>
                    ) : (
                      <button type="button" className="secondary" onClick={onNewPayment}>
                        <ShieldCheck size={14}/> Open structured approval flow
                      </button>
                    )}
                    <button type="button" className="secondary" onClick={()=>onCelo?.(m.proposal)}>
                      <Wallet size={14}/> Prepare wallet-signed Celo payment
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && <div className="operator-message agent"><span>33</span><p>Checking live 33jack state…</p></div>}
        </div>
        <form className="operator-input" onSubmit={askAgent}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What payments need my attention?"
            maxLength={2000}
          />
          <button className="primary" disabled={busy || !input.trim()}><Send size={16}/> Ask</button>
        </form>
      </div>
    </section>
  );
}

function RecordsWorkspace({ type, payments, onNewPayment, onRecordDeleted }) {
  const [beneficiaries, setBeneficiaries] = useState([]);
  const [deletingId, setDeletingId] = useState("");

  useEffect(() => {
    if (type !== "Beneficiaries") return;
    fetch("/api/beneficiaries")
      .then((r) => r.json())
      .then((d) => setBeneficiaries(Array.isArray(d.beneficiaries) ? d.beneficiaries : []))
      .catch(() => setBeneficiaries([]));
  }, [type]);

  async function removeBeneficiaryRecord(record) {
    const id = record?.id;
    if (!id || deletingId) return;
    setDeletingId(String(id));
    try {
      const result = await deleteStoredRecord(
        "beneficiary",
        id,
        `${record.supplier_name || "beneficiary"} beneficiary record`
      );
      if (result?.deleted) {
        setBeneficiaries((current) => current.filter((item) => String(item.id) !== String(id)));
      }
    } finally {
      setDeletingId("");
    }
  }

  async function removePaymentRecord(record) {
    const id = record?.id;
    if (!id || deletingId) return;
    setDeletingId(String(id));
    try {
      const result = await deleteStoredRecord(
        "payment",
        id,
        `${record.supplier || record.invoice_number || "payment"} record`
      );
      if (result?.deleted) onRecordDeleted?.(id);
    } finally {
      setDeletingId("");
    }
  }

  if (type === "Beneficiaries") {
    return (
      <section className="workspace-page">
        <div className="section-head">
          <div><span className="eyebrow">BENEFICIARY REGISTRY</span><h2>Known supplier payout profiles.</h2></div>
          <p>Profiles are created after successful settlement and only retain limited payout fingerprints such as bank name and last four characters.</p>
        </div>
        <div className="card records-card">
          <div className="records-head records-head-actions"><span>Supplier</span><span>Currency</span><span>Bank / Handle</span><span>Last seen</span><span>Delete</span></div>
          {beneficiaries.length ? beneficiaries.map((b) => (
            <div className="records-row" key={b.id || b.supplier_name + b.destination_currency}>
              <span><b>{b.supplier_name}</b><small>{b.country || "—"}</small></span>
              <span>{b.destination_currency || "—"}</span>
              <span>{b.bank_name || b.payment_handle || "—"}{b.account_last4 ? " · ••••" + b.account_last4 : ""}</span>
              <span>{b.last_seen_at ? new Date(b.last_seen_at).toLocaleString() : "—"}</span>
              <button
                type="button"
                className="record-delete"
                onClick={() => removeBeneficiaryRecord(b)}
                disabled={deletingId === String(b.id)}
                aria-label={`Delete ${b.supplier_name || "beneficiary"}`}
              >
                <Trash2 size={14}/><span>{deletingId === String(b.id) ? "Deleting…" : "Delete"}</span>
              </button>
            </div>
          )) : <div className="empty-records">No verified beneficiary history yet.</div>}
        </div>
      </section>
    );
  }

  const filtered = type === "Approvals"
    ? payments.filter((p) => ["analyzed", "failed"].includes(String(p.status || "")))
    : payments;

  return (
    <section className="workspace-page">
      <div className="section-head">
        <div>
          <span className="eyebrow">{type.toUpperCase()}</span>
          <h2>{type === "Approvals" ? "Payments waiting for a decision." : "Live finance records."}</h2>
        </div>
        <button className="primary" onClick={onNewPayment}><Plus size={16}/> New payment</button>
      </div>
      <div className="card records-card">
        <div className="records-head records-head-actions"><span>Supplier / Invoice</span><span>Amount</span><span>Status</span><span>Route</span><span>Delete</span></div>
        {filtered.length ? filtered.map((p) => (
          <div className="records-row" key={p.id}>
            <span><b>{p.supplier || "Unknown supplier"}</b><small>{p.invoice_number || p.invoice_name || p.id}</small></span>
            <span>{p.source_amount && p.source_currency ? formatMoney(p.source_amount, p.source_currency) : p.destination_amount || "—"}</span>
            <span className="status-raw">{String(p.status || "unknown").replaceAll("_", " ")}</span>
            <span>{p.route || "Route pending"}</span>
            <button
              type="button"
              className="record-delete"
              onClick={() => removePaymentRecord(p)}
              disabled={deletingId === String(p.id)}
              aria-label={`Delete ${p.invoice_number || p.invoice_name || p.id}`}
            >
              <Trash2 size={14}/><span>{deletingId === String(p.id) ? "Deleting…" : "Delete"}</span>
            </button>
          </div>
        )) : <div className="empty-records">No records in this view yet.</div>}
      </div>
    </section>
  );
}


function HomePage() {
  const [menuOpen, setMenuOpen] = useState(false);

  const openApp = (view = "Overview") => {
    window.location.href = appHref(view);
  };

  const homeNav = [
    ["01", "AGENT", "Agent"],
    ["02", "33JACK_PAY", "33Jack Pay"],
    ["03", "INVOICE", "33Jack Invoice"],
    ["04", "SETTLEMENT", "Settlement Network"]
  ];

  const verticalPositions = ["12.6%", "37.5%", "61.9%", "86.2%"];
  const horizontalPositions = ["32.7%", "71.4%"];

  return (
    <section className="jack-home">
      <video
        className="jack-home-video jack-anim-fade-in"
        src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260813_115057_94c3699b-0fd1-4124-bcf3-3626bb8c1f77.mp4"
        autoPlay
        muted
        loop
        playsInline
      />

      <div className="jack-home-layer">
        <nav className="jack-home-nav">
          <div className="jack-home-nav-left">
            <button className="jack-home-wordmark jack-anim-fade-up" style={{animationDelay:"200ms"}} onClick={() => openApp()}>
              33JACK // OPERATOR
            </button>
            <div className="jack-home-links">
              {homeNav.map(([number, label, view], i) => (
                <button
                  key={label}
                  className="jack-home-navitem jack-anim-fade-up"
                  style={{animationDelay:`${350 + i * 100}ms`}}
                  onClick={() => openApp(view)}
                >
                  <span>{number}.</span><b>{label}</b>
                </button>
              ))}
            </div>
          </div>

          <div className="jack-home-status jack-anim-slide-right" style={{animationDelay:"600ms"}}>
            <Wallet size={15} strokeWidth={1.5}/>
            <span>SOLANA_DEVNET</span>
            <span className="accent">[ CONNECTED ]</span>
            <span className="status-label">STATUS:</span>
            <span className="status-chip">TELEGRAM_LIVE</span>
          </div>

          <button
            className="jack-home-menu-toggle jack-anim-fade-in"
            style={{animationDelay:"400ms"}}
            aria-label="Toggle menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className={menuOpen ? "menu-icon hide" : "menu-icon"}><Menu size={22} strokeWidth={1.5}/></span>
            <span className={menuOpen ? "close-icon show" : "close-icon"}><X size={22} strokeWidth={1.5}/></span>
          </button>
        </nav>

        <div className={`jack-home-mobile-menu ${menuOpen ? "open" : ""}`}>
          <button className="jack-home-menu-backdrop" aria-label="Close menu" onClick={() => setMenuOpen(false)}/>
          <div className="jack-home-menu-panel">
            <button className="jack-home-menu-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
              <X size={22} strokeWidth={1.5}/>
            </button>
            <div className="jack-home-menu-list">
              {homeNav.map(([number, label, view], i) => (
                <button
                  key={label}
                  style={{transitionDelay: menuOpen ? `${150 + i * 75}ms` : "0ms"}}
                  onClick={() => openApp(view)}
                >
                  <span>{number}.</span><b>{label}</b>
                </button>
              ))}
            </div>
            <div className="jack-home-mobile-status" style={{transitionDelay:menuOpen?"450ms":"0ms"}}>
              <div><Wallet size={15} strokeWidth={1.5}/><span>SOLANA_DEVNET</span><span className="accent">[ CONNECTED ]</span></div>
              <div><span>STATUS:</span><span className="status-chip">TELEGRAM_LIVE</span></div>
            </div>
          </div>
        </div>

        <h1 className="jack-home-title jack-anim-fade-up" style={{animationDelay:"400ms"}}>
          Global Payments.<br/>Human Approved.
        </h1>

        <div className="jack-home-grid" aria-hidden="true">
          {verticalPositions.map((left, i) => (
            <i className="jack-grid-v jack-anim-grid-v" key={left} style={{left,animationDelay:`${600+i*100}ms`}}/>
          ))}
          {horizontalPositions.map((top, i) => (
            <i className="jack-grid-h jack-anim-grid-h" key={top} style={{top,animationDelay:`${800+i*150}ms`}}/>
          ))}
          {horizontalPositions.flatMap((top, hi) =>
            verticalPositions.map((left, vi) => (
              <span
                className="jack-grid-plus jack-anim-scale-in"
                key={top+left}
                style={{top,left,animationDelay:`${1000+(hi*4+vi)*80}ms`}}
              >
                <i/><b/>
              </span>
            ))
          )}
        </div>

        <div className="jack-home-nodes" aria-hidden="true">
          <div className="jack-node-square node-one jack-anim-scale-in" style={{animationDelay:"1500ms"}}/>
          <div className="jack-node-square node-two jack-anim-scale-in" style={{animationDelay:"1800ms"}}/>
          <div className="jack-node-square node-three jack-anim-scale-in" style={{animationDelay:"2100ms"}}/>

          <div className="jack-node-label label-one jack-anim-slide-left" style={{animationDelay:"1100ms"}}>
            <span>[ INVOICE_INTELLIGENCE ]</span>
            <p>Reads invoices, extracts obligations and surfaces payment risk.</p>
          </div>
          <div className="jack-node-label label-two jack-anim-slide-left" style={{animationDelay:"1400ms"}}>
            <span>[ HUMAN_APPROVAL ]</span>
            <p>Binds approval to the exact amount, beneficiary and route.</p>
          </div>
          <div className="jack-node-label label-three jack-anim-slide-right" style={{animationDelay:"1700ms"}}>
            <span>[ SETTLEMENT_NETWORK ]</span>
            <p>Routes approved payments across stablecoin and payout rails.</p>
          </div>

          {[
            ["38%","14%","52%","14%",1200],
            ["52%","14%","60%","27%",1400],
            ["32%","58%","20%","74%",1500],
            ["20%","74%","6%","74%",1700],
            ["78%","53%","63%","53%",1800],
            ["63%","53%","50%","63%",2000]
          ].map(([x1,y1,x2,y2,delay],i) => (
            <svg className="jack-connector jack-anim-fade-in" style={{animationDelay:`${delay}ms`}} key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.25)" strokeWidth="1" vectorEffect="non-scaling-stroke"/>
            </svg>
          ))}
        </div>

        <div className="jack-home-bottom">
          <div className="jack-home-bottom-left">
            <button className="jack-home-cta jack-anim-fade-up" style={{animationDelay:"900ms"}} onClick={() => openApp()}>
              <span>✦</span><b>OPEN 33JACK</b>
            </button>

            <div className="jack-home-channels jack-anim-fade-up" style={{animationDelay:"1050ms"}} aria-label="33JACK messaging channels">
              <span className="jack-home-channels-label">USE 33JACK ON</span>
              <button type="button" className="jack-home-channel is-live" onClick={() => openApp("Channels")} title="Telegram — Live" aria-label="Telegram — Live">
                <img src="https://cdn.simpleicons.org/telegram/FFFFFF" alt="Telegram"/>
                <i/>
              </button>
              <span className="jack-home-channel" title="WhatsApp — Coming soon" aria-label="WhatsApp — Coming soon">
                <img src="https://cdn.simpleicons.org/whatsapp/FFFFFF" alt="WhatsApp"/>
              </span>
              <span className="jack-home-channel" title="WeChat — Coming soon" aria-label="WeChat — Coming soon">
                <img src="https://cdn.simpleicons.org/wechat/FFFFFF" alt="WeChat"/>
              </span>
              <span className="jack-home-channel snapchat" title="Snapchat — Coming soon" aria-label="Snapchat — Coming soon">
                <img src="https://cdn.simpleicons.org/snapchat/FFFFFF" alt="Snapchat"/>
              </span>
              <span className="jack-home-coming-soon">3 COMING SOON</span>
            </div>
          </div>

          <div className="jack-home-info jack-anim-slide-right" style={{animationDelay:"1100ms"}}>
            <span className="jack-home-info-badge">AI FINANCE OPERATOR — NOT A BANK</span>
            <div className="jack-home-info-body">
              <svg viewBox="0 0 280 168" preserveAspectRatio="none" aria-hidden="true">
                <polygon points="0.5,0.5 279.5,0.5 279.5,167.5 30,167.5 0.5,137.5" fill="none" stroke="#AFDDFF" strokeWidth="1" vectorEffect="non-scaling-stroke"/>
              </svg>
              <p>33JACK reads invoices, checks risk, prepares the best route, waits for exact human approval, executes and reconciles the result.</p>
              <button onClick={() => openApp("Overview")}>VIEW_33JACK_WORKSPACE</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function App() {
  const [active, setActive] = useState(() => viewFromLocation());
  const [flow, setFlow] = useState(false);
  const [invoiceSeed, setInvoiceSeed] = useState(null);
  const [livePayments, setLivePayments] = useState([]);
  const [persistence, setPersistence] = useState("loading");
  const [externalReview, setExternalReview] = useState(null);
  const [externalReviewError, setExternalReviewError] = useState("");
  const [celoSeed, setCeloSeed] = useState(null);

  function navigateTo(view, options = {}) {
    const nextView = APP_ROUTES[view] ? view : "Overview";
    const target = appHref(nextView);
    const currentPath = window.location.pathname.replace(/\/$/, "") || "/";
    if (currentPath !== target) {
      window.history[options.replace ? "replaceState" : "pushState"]({}, "", target);
    }
    setActive(nextView);
    window.scrollTo({ top: 0, behavior: options.instant ? "auto" : "smooth" });
  }

  useEffect(() => {
    const onPopState = () => {
      setActive(viewFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function handleRecordDeleted(id) {
    setLivePayments((current) => current.filter((payment) => String(payment.id) !== String(id)));
    if (String(invoiceSeed?.id || "") === String(id)) setInvoiceSeed(null);
  }

  async function refreshPayments() {
    try {
      const response = await fetch("/api/payments?limit=25");
      const data = await readApiResponse(response);
      if (!response.ok) return;
      setLivePayments(Array.isArray(data.payments) ? data.payments : []);
      setPersistence(data.persistence || "unknown");
    } catch {
      setPersistence("unavailable");
    }
  }

  useEffect(() => {
    refreshPayments();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const channel = String(params.get("channel") || "").toLowerCase();
    const paymentId = params.get("paymentId");
    const token =
      channel === "wechat"
        ? params.get("wxToken")
        : params.get("waToken");

    if (window.location.pathname.startsWith("/app/celo")) return;
    if (!["whatsapp", "wechat"].includes(channel) || !paymentId || !token) return;

    let cancelled = false;
    setExternalReviewError("");
    fetch(
      `/api/agent?provider=${channel}-review&paymentId=${encodeURIComponent(paymentId)}&token=${encodeURIComponent(token)}`
    )
      .then(async (response) => {
        const data = await readApiResponse(response);
        if (!response.ok) {
          throw new Error(
            data.detail ||
            data.error ||
            `${channel === "wechat" ? "WeChat" : "WhatsApp"} review link could not be verified`
          );
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setExternalReview({
          payment: data.payment,
          workspace: data.workspace,
          context: { channel, token }
        });
        setFlow(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setExternalReviewError(
            error.message ||
            `${channel === "wechat" ? "WeChat" : "WhatsApp"} review link failed`
          );
        }
      });

    return () => { cancelled = true; };
  }, []);

  function routeInvoiceToPayment(invoice) {
    setInvoiceSeed(invoice);
    const currency = String(invoice?.source_currency || invoice?.destination_currency || "").toUpperCase();
    if (["USDG", "USDC", "USDT"].includes(currency)) {
      navigateTo("33Jack Crypto");
    } else {
      navigateTo("33Jack Pay");
    }
  }

  const dashboardPayments = livePayments.length
    ? livePayments.map((p) => ({
        company: p.supplier || "Unknown supplier",
        invoice: p.invoice_number || p.invoice_name || p.id,
        amount: p.source_amount && p.source_currency
          ? formatMoney(p.source_amount, p.source_currency)
          : p.destination_amount || "—",
        route: p.route || "Route pending",
        status:
          ["settled_devnet","settled_demo","settled_celo"].includes(p.status) ? "Settled"
          : p.status === "approved" || p.status === "settling" ? "Review"
          : p.risk?.duplicate || p.risk?.beneficiary_changed || p.risk?.suspicious ? "Flagged"
          : "Review",
        time: p.created_at ? new Date(p.created_at).toLocaleString() : "Recorded"
      }))
    : samplePayments;

  const settledCount = livePayments.filter((p) => String(p.status).startsWith("settled_")).length;
  const flaggedCount = livePayments.filter((p) => p.risk?.duplicate || p.risk?.beneficiary_changed || p.risk?.suspicious).length;

  return (
    <div className="app alwayzz-app">
      <div className="app-topnav-wrap">
        <div className="app-topnav">
          <button className="app-wordmark" type="button" onClick={() => navigateTo("Overview")}>
            <span>33jack</span><sup>®</sup>
          </button>
          <div className="app-topnav-actions">
            <span className="app-route-label">{active}</span>
            <button className="app-new-payment" type="button" onClick={() => setFlow(true)}>
              <Plus size={15}/> New payment
            </button>
          </div>
        </div>

        <div className="app-function-nav-shell">
          <nav className="app-function-nav" aria-label="33JACK products">
            {nav.map(([label, Icon]) => (
              <button
                type="button"
                key={label}
                className={active === label ? "active" : ""}
                onClick={() => navigateTo(label)}
                aria-current={active === label ? "page" : undefined}
              >
                <Icon size={14}/>
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="app-main">
        <div className="content">
          {externalReviewError && (
            <div style={{marginBottom:16,padding:"12px 14px",border:"1px solid rgba(255,111,125,.25)",borderRadius:12,color:"#ff8994",fontSize:12}}>
              {externalReviewError}
            </div>
          )}
          {active === "Overview" ? <>
          <section className="hero app-interior-hero">
            <div className="hero-lines hero-lines-left" aria-hidden="true">
              {Array.from({ length: 20 }).map((_, i) => <i key={"l" + i} style={{ width: 60 + i * 10, animationDelay: i * .25 + "s" }}/>)}
            </div>
            <div className="hero-lines hero-lines-right" aria-hidden="true">
              {Array.from({ length: 20 }).map((_, i) => <i key={"r" + i} style={{ width: 60 + i * 10, animationDelay: i * .25 + "s" }}/>)}
            </div>
            <div className="hero-lines hero-lines-top" aria-hidden="true">
              {Array.from({ length: 20 }).map((_, i) => <i key={"t" + i} style={{ width: 60 + i * 10, animationDelay: i * .25 + "s" }}/>)}
            </div>

            <div className="app-hero-content">
              <div className="app-ticker" aria-label="33JACK capabilities">
                <div className="app-ticker-track">
                  {Array.from({ length: 4 }).flatMap((_, repeat) =>
                    ["Invoice Intelligence", "Cross-border Pay", "Voice Pay", "Stablecoin Settlement", "Reconciliation"].map((item) => (
                      <span key={repeat + item}>{item}</span>
                    ))
                  )}
                </div>
              </div>

              <h1>Finance work, <span className="serif-italic">33jack</span><sup>®</sup> on demand.</h1>
              <p>
                One AI finance operator for invoices, risk, routing, approvals, stablecoin settlement,
                local payouts and reconciliation — on your timeline.
              </p>

              <div className="app-hero-cta">
                <button className="app-primary-pill" type="button" onClick={() => setFlow(true)}>New payment</button>
                <button className="app-chat-pill" type="button" onClick={() => navigateTo("Agent")}>
                  <img src="https://framerusercontent.com/images/hfneFL6CHBi5BnNvCeOaqU9HqE4.png" alt="" />
                  <span><b>Ask 33JACK</b><small><i/> Ready now</small></span>
                </button>
              </div>
            </div>
            <div className="app-progressive-blur" aria-hidden="true"/>
          </section>

          <section className="app-trusted">
            <p>Built across the rails and infrastructure 33JACK uses today.</p>
            <div className="app-trusted-marquee">
              <div className="app-trusted-track">
                {Array.from({ length: 4 }).flatMap((_, repeat) =>
                  ["Celo", "USDC", "USDT", "Solana", "Wise", "USDG", "Telegram", "Groq", "Neon", "Vercel", "Wallets", "Global payouts"].map((item, i) => (
                    <span key={repeat + item} className={"logo-type logo-" + (i % 5)}>{item}</span>
                  ))
                )}
              </div>
            </div>
          </section>

          <SubunitCards onOpen={navigateTo}/>

          <section className="metrics">
            <Metric label="Payment records" value={livePayments.length || "—"} sub={livePayments.length ? `${persistence} persistence` : "No live records yet"}/>
            <Metric label="Invoices analyzed" value={livePayments.filter((p) => p.status).length || "—"} sub="Stored payment workflow records"/>
            <Metric label="Risk flags" value={flaggedCount || "—"} sub="Duplicate / beneficiary / suspicious"/>
            <Metric label="Settled" value={settledCount || "—"} sub="Devnet + safe demo settlements"/>
          </section>

          <section className="panel-grid">
            <div className="card recent">
              <div className="card-head"><div><span className="eyebrow">OPERATIONS</span><h3>Recent activity</h3></div><button>View all</button></div>
              <div className="table">
                <div className="tr th"><span>Supplier</span><span>Amount</span><span>Route</span><span>Status</span></div>
                {dashboardPayments.map((p) => (
                  <div className="tr" key={p.invoice}>
                    <span><i className="company-icon">{p.company.slice(0,2).toUpperCase()}</i><b>{p.company}</b><small>{p.invoice} · {p.time}</small></span>
                    <span><b>{p.amount}</b></span>
                    <span>{p.route}</span>
                    <span><StatusPill status={p.status}/></span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card agent-card">
              <div className="agent-title"><div className="agent-glow"><Bot size={23}/></div><div><span className="eyebrow">33JACK AGENT</span><h3>Finance work, already prepared.</h3></div></div>
              <div className="agent-task"><TriangleAlert size={18}/><div><b>1 beneficiary change needs review</b><p>Shenzhen Nova Parts · ¥42,000</p></div><ChevronRight size={18}/></div>
              <div className="agent-task"><Clock3 size={18}/><div><b>3 invoices due tomorrow</b><p>£16,770 total · proposals ready</p></div><ChevronRight size={18}/></div>
              <div className="agent-task"><BadgeCheck size={18}/><div><b>8 payments reconciled</b><p>Evidence matched automatically</p></div><ChevronRight size={18}/></div>
              <button className="agent-command" onClick={() => setFlow(true)}><Sparkles size={17}/> Ask 33jack to prepare a payment <ArrowRight size={17}/></button>
            </div>
          </section>

          <section className="workflow">
            <div className="section-head">
              <div><span className="eyebrow">THE 33JACK LOOP</span><h2>From messy instruction to reconciled payment.</h2></div>
              <p>AI prepares. Deterministic controls verify. A human approves. 33jack executes and follows the payment until the books match.</p>
            </div>
            <div className="step-grid">
              {steps.map(([title, body, Icon], i) => <div className="step" key={title}><span className="num">0{i+1}</span><Icon/><h4>{title}</h4><p>{body}</p></div>)}
            </div>
          </section>

          <ChannelPreview/>

          <section className="rail-section">
            <div>
              <span className="eyebrow">GLOBAL RAILS · ONE INSTRUCTION</span>
              <h2>The customer asks for an outcome.<br/>33jack handles the plumbing.</h2>
            </div>
            <div className="rails">
              <div><span className="sol-symbol">S</span><b>Solana</b><small>USDG settlement</small></div>
              <ArrowRight/>
              <div><Banknote/><b>Banks</b><small>Local payouts</small></div>
              <ArrowRight/>
              <div><MessageCircleMore/><b>Wallets</b><small>Approved endpoints</small></div>
              <ArrowRight/>
              <div><Globe2/><b>Global</b><small>More corridors</small></div>
            </div>
          </section>

          <footer><Logo/><p>Autonomous cross-border finance for global businesses.</p><span>Colosseum build · Solana</span></footer>
          </> : active === "Agent" ? (
            <AgentWorkspace onNewPayment={() => setFlow(true)} onCelo={(proposal)=>{setCeloSeed(proposal);navigateTo("Celo Mainnet");}}/>
          ) : active === "Voice Pay β" ? (
            <VoicePayWorkspace/>
          ) : active === "Jack Swipe β" ? (
            <JackSwipeWorkspace
              payments={livePayments}
              onRefresh={refreshPayments}
              onReview={(payment) => {
                setExternalReview({ payment, context: null });
                setFlow(true);
              }}
            />
          ) : active === "Channels" ? (
            <ChannelsWorkspace/>
          ) : active === "33Jack Pay" ? (
            <PayWorkspace seed={invoiceSeed} onNewPayment={() => setFlow(true)}/>
          ) : active === "33Jack Crypto" ? (
            <CryptoWorkspace seed={invoiceSeed} onNewPayment={() => setFlow(true)}/>
          ) : active === "33Jack Invoice" ? (
            <InvoiceWorkspace onUseInvoice={routeInvoiceToPayment} onNewPayment={() => setFlow(true)}/>
          ) : active === "Settlement Network" ? (
            <SettlementNetworkWorkspace/>
          ) : active === "Celo Mainnet" ? (
            <CeloWorkspace seed={celoSeed}/>
          ) : (
            <RecordsWorkspace
              type={active}
              payments={livePayments}
              onNewPayment={() => setFlow(true)}
              onRecordDeleted={handleRecordDeleted}
            />
          )}
        </div>
      </main>
      {flow && (
        <PaymentFlow
          initialPayment={externalReview?.payment || null}
          channelContext={externalReview?.context || null}
          close={() => {
            setFlow(false);
            setExternalReview(null);
          }}
          onComplete={refreshPayments}
        />
      )}
    </div>
  );
}

function Root() {
  const params = new URLSearchParams(window.location.search);
  const hasExternalReview = Boolean(
    params.get("channel") &&
    params.get("paymentId") &&
    (params.get("waToken") || params.get("wxToken"))
  );
  const showApp = window.location.pathname.startsWith("/app") || hasExternalReview;
  return showApp ? <App/> : <HomePage/>;
}

createRoot(document.getElementById("root")).render(<AppErrorBoundary><Root/></AppErrorBoundary>);
