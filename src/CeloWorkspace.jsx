import React, { useEffect, useState } from "react";
import "./celo.css";

const API = "/api/v2/agent";
const CELO = "/api/v2/celo";
const DEFAULT_NETWORK = {
  chainId: 42220, chainIdHex: "0xa4ec", name: "Celo Mainnet",
  rpcUrls: ["https://forno.celo.org"],
  nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 },
  explorer: "https://celoscan.io"
};

async function jsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 202) throw new Error(data.error || "Request failed");
  return data;
}

export default function CeloWorkspace() {
  const [network, setNetwork] = useState(DEFAULT_NETWORK);
  const [tokens, setTokens] = useState([]);
  const [health, setHealth] = useState(null);
  const [wallet, setWallet] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [approvalKey, setApprovalKey] = useState("");
  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [memo, setMemo] = useState("");
  const [intent, setIntent] = useState(null);
  const [unsignedTx, setUnsignedTx] = useState(null);
  const [txHash, setTxHash] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(CELO + "?operation=health").then(async response => {
      const data = await response.json();
      if (!active) return;
      if (data.network) setNetwork(data.network);
      if (data.tokens) setTokens(data.tokens);
      setHealth(data.rpc?.correctNetwork === true);
    }).catch(() => { if (active) setHealth(false); });
    return () => { active = false; };
  }, []);

  function headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      "x-jack-agent-id": agentId.trim(),
      Authorization: "Bearer " + agentKey.trim(),
      ...extra
    };
  }

  async function request(operation, method, payload, extraHeaders = {}) {
    return jsonResponse(await fetch(API + "?operation=" + operation + (method === "GET" ? "&id=" + encodeURIComponent(payload.id) : ""), {
      method,
      headers: headers(extraHeaders),
      ...(method === "POST" ? { body: JSON.stringify(payload) } : {})
    }));
  }

  async function perform(fn) {
    setError("");
    setMessage("");
    setWorking(true);
    try { await fn(); } catch (e) { setError(e?.message || "Action failed"); }
    finally { setWorking(false); }
  }

  async function connect() {
    await perform(async () => {
      if (!window.ethereum?.request) throw new Error("No EVM wallet detected. Open this page in MetaMask or another EVM wallet.");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts?.[0]) throw new Error("Wallet connection declined");
      setWallet(accounts[0]);
      setMessage("Wallet connected. Only you can approve and sign transactions.");
    });
  }

  async function propose() {
    await perform(async () => {
      if (!wallet) throw new Error("Connect a wallet first to bind the proposal to its payer");
      if (!agentId.trim() || !agentKey.trim()) throw new Error("Enter the configured agent ID and agent API key");
      const idempotency = crypto.randomUUID();
      const data = await request("propose", "POST", {
        network: "celo", token, amount, recipient, payer: wallet, memo
      }, { "Idempotency-Key": idempotency });
      setIntent(data.intent);
      setUnsignedTx(null);
      setTxHash("");
      setMessage("Proposal created. A separate human approval credential is required before payment.");
    });
  }

  async function approve() {
    await perform(async () => {
      if (!intent || intent.status !== "proposed") throw new Error("No pending proposal");
      if (!window.confirm("Approve " + intent.amount + " " + intent.token + " from " + intent.payer + " to " + intent.recipient + " on Celo Mainnet?")) return;
      const data = await request("approve", "POST", {
        id: intent.id, confirmation: "APPROVE:" + intent.id
      }, { "x-jack-approval-key": approvalKey });
      setIntent(data.intent);
      setUnsignedTx(data.unsignedTransaction);
      setMessage("Approved. Only your wallet can sign and broadcast this payment.");
    });
  }

  async function switchToCelo() {
    const provider = window.ethereum;
    const current = await provider.request({ method: "eth_chainId" });
    if (current?.toLowerCase() === network.chainIdHex.toLowerCase()) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: network.chainIdHex }] });
    } catch (err) {
      if (err?.code !== 4902 && err?.data?.originalError?.code !== 4902) throw err;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: network.chainIdHex, chainName: network.name,
          nativeCurrency: network.nativeCurrency,
          rpcUrls: network.rpcUrls, blockExplorerUrls: [network.explorer]
        }]
      });
    }
  }

  async function send() {
    await perform(async () => {
      if (!window.ethereum?.request) throw new Error("Wallet unavailable");
      if (!intent || intent.status !== "approved" || !unsignedTx) throw new Error("A human-approved transaction is required");
      if (!wallet || wallet.toLowerCase() !== intent.payer?.toLowerCase()) throw new Error("Connected wallet does not match approved payer");
      if (new Date(intent.expiresAt).getTime() <= Date.now()) throw new Error("Approval expired; create a fresh proposal");
      await switchToCelo();
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (!accounts?.some(a => a.toLowerCase() === wallet.toLowerCase())) throw new Error("Wallet account changed");
      const hash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet, to: unsignedTx.to, data: unsignedTx.data, value: unsignedTx.value }]
      });
      setTxHash(hash);
      setMessage("Transaction broadcast by your wallet. Reconcile to verify Celo confirmations.");
    });
  }

  async function reconcile() {
    await perform(async () => {
      if (!intent || !txHash) throw new Error("No transaction hash yet");
      const data = await request("confirm", "POST", { id: intent.id, txHash });
      if (data.status === "pending") {
        setMessage((data.reason || "Transaction pending") + ". Use Reconcile again after the next Celo block.");
        return;
      }
      setIntent(data.intent);
      setMessage("Verified: exact token, recipient, payer, amount, confirmations and unique transaction hash match.");
    });
  }

  async function refresh() {
    await perform(async () => {
      if (!intent) throw new Error("No current proposal");
      const data = await request("intent", "GET", { id: intent.id });
      setIntent(data.intent);
      setUnsignedTx(data.unsignedTransaction);
      setMessage("Payment status refreshed.");
    });
  }

  return (
    <section className="celo-v2">
      <header className="celo-v2-hero">
        <div><span className="eyebrow">33JACK V2 · CELO MAINNET</span><h2>Payments infrastructure for people and AI agents.</h2>
          <p>Prepare payment intents through 33JACK, require separate human approval, sign with your wallet and reconcile against Celo onchain evidence.</p></div>
        <span className="celo-v2-chain">◉ Celo · 42220</span>
      </header>
      <div className="celo-v2-metrics">
        <div><small>Settlement network</small><b>Celo Mainnet</b></div>
        <div><small>RPC status</small><b>{health === null ? "Checking…" : health ? "Connected" : "Unavailable"}</b></div>
        <div><small>Wallet custody</small><b>Self-custody</b></div>
        <div><small>Signing policy</small><b>Human + wallet</b></div>
      </div>
      <div className="celo-v2-grid">
        <article className="celo-v2-panel">
          <span className="eyebrow">01 / CONNECT</span><h3>Connect your Celo wallet</h3>
          <p>Transactions are signed in MetaMask or a compatible EVM wallet. No private key is stored by 33JACK.</p>
          <button type="button" className="celo-v2-primary" disabled={working} onClick={connect}>{wallet ? "Connected · " + wallet.slice(0, 7) + "…" + wallet.slice(-4) : "Connect wallet"}</button>
        </article>
        <article className="celo-v2-panel">
          <span className="eyebrow">02 / AGENT CREDENTIALS</span><h3>Agent authentication</h3>
          <p>Use server-configured V2 agent credentials. Keys remain in this page's memory, not browser storage.</p>
          <label>Agent ID<input autoComplete="off" value={agentId} onChange={e => setAgentId(e.target.value)} placeholder="my-agent" /></label>
          <label>Agent API key<input type="password" autoComplete="off" value={agentKey} onChange={e => setAgentKey(e.target.value)} placeholder="Agent secret" /></label>
        </article>
        <article className="celo-v2-panel">
          <span className="eyebrow">03 / PAYMENT INTENT</span><h3>Prepare a payment</h3>
          <div className="celo-v2-two">
            <label>Token<select value={token} onChange={e => setToken(e.target.value)}>{(tokens.length ? tokens : [{symbol:"USDC"},{symbol:"USDT"},{symbol:"cUSD"}]).map(t => <option value={t.symbol} key={t.symbol}>{t.symbol}</option>)}</select></label>
            <label>Amount<input value={amount} inputMode="decimal" onChange={e => setAmount(e.target.value)} placeholder="1.00"/></label>
          </div>
          <label>Recipient address<input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="0x…" spellCheck={false}/></label>
          <label>Memo / invoice<input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Vendor invoice #123"/></label>
          <button type="button" className="celo-v2-primary" disabled={working || !wallet} onClick={propose}>Create approval-required proposal</button>
        </article>
        <article className="celo-v2-panel">
          <span className="eyebrow">04 / APPROVE & SETTLE</span><h3>Human-controlled execution</h3>
          <p>No agent can send funds on its own. Human approval and a separate wallet signature are mandatory.</p>
          <label>Separate approval credential<input type="password" autoComplete="off" value={approvalKey} onChange={e => setApprovalKey(e.target.value)} placeholder="Human approval secret"/></label>
          <div className="celo-v2-actions">
            <button type="button" disabled={working || intent?.status !== "proposed"} onClick={approve}>Approve exact terms</button>
            <button type="button" disabled={working || intent?.status !== "approved" || !unsignedTx || Boolean(txHash)} onClick={send}>Send with wallet</button>
            <button type="button" disabled={working || !txHash || intent?.status === "confirmed"} onClick={reconcile}>Reconcile onchain</button>
          </div>
        </article>
      </div>
      {intent && <article className="celo-v2-panel celo-v2-result">
        <div className="celo-v2-result-head"><div><span className="eyebrow">PAYMENT RECEIPT</span><h3>{intent.status.toUpperCase()}</h3></div><button type="button" onClick={refresh} disabled={working}>Refresh</button></div>
        <dl><div><dt>Intent</dt><dd>{intent.id}</dd></div><div><dt>Token / amount</dt><dd>{intent.amount} {intent.token}</dd></div><div><dt>Recipient</dt><dd>{intent.recipient}</dd></div><div><dt>Expiry</dt><dd>{new Date(intent.expiresAt).toLocaleString()}</dd></div></dl>
        {(txHash || intent.txHash) && <p>Transaction: <a href={network.explorer + "/tx/" + (txHash || intent.txHash)} target="_blank" rel="noreferrer">{txHash || intent.txHash}</a></p>}
      </article>}
      {message && <p className="celo-v2-message" role="status">{message}</p>}
      {error && <p className="celo-v2-error" role="alert">{error}</p>}
      <p className="celo-v2-disclaimer">Live Celo transfer flow. USDC, USDT and cUSD are real assets. Legacy Solana/FX sandbox routes remain separate. Do not enter credentials on an untrusted deployment.</p>
    </section>
  );
}
