/**
 * 33JACK V2 / Celo Mainnet wallet-signed ERC-20 rail.
 * No custodial private keys. Only approved proposals produce wallet-call data.
 */
export const CELO_NETWORK = Object.freeze({
  id: "celo",
  name: "Celo Mainnet",
  chainId: 42220,
  chainIdHex: "0xa4ec",
  rpcUrls: ["https://forno.celo.org"],
  explorer: "https://celoscan.io",
  nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 }
});

export const CELO_TOKENS = Object.freeze({
  USDC: { symbol: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
  USDT: { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
  USDm: { symbol: "USDm", address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 }
});

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d+)?$/;

export function normalizeAddress(value, label = "address") {
  const address = String(value || "").trim();
  if (!ADDRESS_RE.test(address)) throw new Error(label + " must be a 20-byte EVM address");
  if (/^0x0{40}$/i.test(address)) throw new Error(label + " cannot be the zero address");
  return address.toLowerCase();
}

export function parseTokenAmount(value, decimals) {
  const amount = String(value ?? "").trim();
  if (!AMOUNT_RE.test(amount)) throw new Error("Amount must be a positive decimal string (no exponent or sign)");
  const parts = amount.split(".");
  if ((parts[1] || "").length > decimals) throw new Error("Amount exceeds token precision");
  const units = BigInt(parts[0]) * (10n ** BigInt(decimals)) +
    BigInt((parts[1] || "").padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new Error("Amount must be greater than zero");
  const limit = Number(process.env.CELO_MAX_PAYMENT_USD || 100);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("CELO_MAX_PAYMENT_USD is invalid");
  // All supported tokens are USD stablecoins; this is a nominal, not live-FX, policy ceiling.
  if (units > parseUnitLimit(String(limit), decimals)) throw new Error("Amount exceeds Celo per-payment policy limit");
  return units.toString();
}

function parseUnitLimit(value, decimals) {
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fractional.slice(0, decimals).padEnd(decimals, "0") || "0");
}

export function normalizeCeloProposal(input = {}) {
  const requestedToken = String(input.token || "USDC").trim();
  const key = ["CUSD", "USDM"].includes(requestedToken.toUpperCase()) ? "USDm" : requestedToken.toUpperCase();
  const token = CELO_TOKENS[key];
  if (!token) throw new Error("Supported Celo assets: USDC, USDT, USDm (formerly cUSD)");
  const recipient = normalizeAddress(input.recipient, "recipient");
  const payer = input.payer ? normalizeAddress(input.payer, "payer") : null;
  const amount = String(input.amount ?? "").trim();
  const amountUnits = parseTokenAmount(amount, token.decimals);
  const memo = String(input.memo || "").trim().slice(0, 240);
  return { network: "celo", chainId: 42220, token: token.symbol, tokenAddress: token.address.toLowerCase(), decimals: token.decimals, amount, amountUnits, recipient, payer, memo };
}

export function prepareCeloTransfer(proposal) {
  const token = CELO_TOKENS[proposal.token === "cUSD" ? "USDm" : proposal.token];
  if (!token || token.address.toLowerCase() !== proposal.tokenAddress.toLowerCase()) {
    throw new Error("Unsupported token contract");
  }
  const amountUnits = BigInt(proposal.amountUnits);
  if (amountUnits <= 0n || amountUnits >= (1n << 256n)) throw new Error("Invalid transfer amount");
  const data = "0xa9059cbb" +
    normalizeAddress(proposal.recipient).slice(2).padStart(64, "0") +
    amountUnits.toString(16).padStart(64, "0");
  return { chainId: CELO_NETWORK.chainId, to: token.address, data, value: "0x0", payer: proposal.payer };
}

export async function celoRpc(method, params = []) {
  const url = String(process.env.CELO_RPC_URL || CELO_NETWORK.rpcUrls[0]).trim();
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1:")) throw new Error("CELO_RPC_URL must be HTTPS");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 33, method, params }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Celo RPC returned HTTP " + response.status);
  const result = await response.json();
  if (result.error) throw new Error("Celo RPC error " + String(result.error.code || "unknown"));
  return result.result;
}

export async function celoHealth() {
  const chainId = await celoRpc("eth_chainId");
  return { reachable: true, chainId: Number(BigInt(chainId)), correctNetwork: Number(BigInt(chainId)) === CELO_NETWORK.chainId };
}

function extractTransfer(log, proposal) {
  if (String(log.address || "").toLowerCase() !== proposal.tokenAddress.toLowerCase()) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 3) return null;
  if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = "0x" + String(log.topics[1]).slice(-40).toLowerCase();
  const to = "0x" + String(log.topics[2]).slice(-40).toLowerCase();
  if (to !== proposal.recipient.toLowerCase()) return null;
  if (proposal.payer && from !== proposal.payer.toLowerCase()) return null;
  if (!/^0x[0-9a-f]+$/i.test(String(log.data || ""))) return null;
  if (BigInt(log.data) !== BigInt(proposal.amountUnits)) return null;
  return { from, to, amountUnits: proposal.amountUnits, logIndex: log.logIndex };
}

export async function verifyCeloPayment(proposal, hash, approvedAt) {
  const txHash = String(hash || "").trim();
  if (!HASH_RE.test(txHash)) throw new Error("Invalid transaction hash");
  if (!proposal.payer) throw new Error("Verified transfer requires a specified payer wallet");
  const [chain, receipt, currentBlock, transaction] = await Promise.all([
    celoRpc("eth_chainId"), celoRpc("eth_getTransactionReceipt", [txHash]), celoRpc("eth_blockNumber"), celoRpc("eth_getTransactionByHash", [txHash])
  ]);
  if (Number(BigInt(chain)) !== CELO_NETWORK.chainId) throw new Error("RPC is not connected to Celo Mainnet");
  if (!receipt) return { pending: true, reason: "Transaction not yet mined" };
  if (receipt.status !== "0x1") throw new Error("Onchain transaction reverted");
  if (!transaction) return {pending:true,reason:"Transaction details not yet available"};
  const expected=prepareCeloTransfer(proposal);
  if (String(transaction.hash||"").toLowerCase()!==txHash.toLowerCase()) throw new Error("Transaction hash mismatch");
  if (String(transaction.from||"").toLowerCase()!==proposal.payer.toLowerCase()) throw new Error("Transaction payer mismatch");
  if (String(transaction.to||"").toLowerCase()!==expected.to.toLowerCase()) throw new Error("Transaction token contract mismatch");
  if (String(transaction.input||transaction.data||"").toLowerCase()!==expected.data.toLowerCase()) throw new Error("Transaction calldata mismatch");
  if (BigInt(transaction.value||"0x0")!==0n) throw new Error("Unexpected native currency transfer");
  if (String(transaction.blockNumber||"").toLowerCase()!==String(receipt.blockNumber).toLowerCase()) throw new Error("Transaction and receipt disagree on block");

  if (String(receipt.transactionHash || "").toLowerCase() !== txHash.toLowerCase()) throw new Error("Receipt hash mismatch");
  const minedBlock = BigInt(receipt.blockNumber);
  const confirmations = BigInt(currentBlock) - minedBlock + 1n;
  const configured = Number(process.env.CELO_MIN_CONFIRMATIONS || 2);
  const minConfirmations = Number.isInteger(configured) && configured >= 1 && configured <= 100 ? configured : 2;
  if (confirmations < BigInt(minConfirmations)) return { pending: true, reason: "Waiting for confirmations", confirmations: Number(confirmations), required: minConfirmations };
  const matchingLog = (receipt.logs || []).map(log => extractTransfer(log, proposal)).find(Boolean);
  if (!matchingLog) throw new Error("No exact approved ERC-20 Transfer event found");
  if (approvedAt) {
    const block = await celoRpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (!block?.timestamp) throw new Error("Could not verify block timestamp");
    const blockMs = Number(BigInt(block.timestamp)) * 1000;
    if (blockMs + 10000 < new Date(approvedAt).getTime()) throw new Error("Transfer predates proposal approval");
  }
  return { pending: false, chainId: 42220, txHash: txHash.toLowerCase(), token: proposal.token, ...matchingLog, confirmations: Number(confirmations), explorerUrl: CELO_NETWORK.explorer + "/tx/" + txHash };
}
