import { isAddress, getAddress } from 'https://esm.sh/viem@2.21.55';
import * as S from 'solana';
import * as B from 'base';

const IRIS = 'https://iris-api.circle.com';
const FINALITY = { fast: 1000, standard: 2000 };
const SLIPPAGE_BPS = 50; // 0.5%
// Paying with USDT, the swap takes a moment during which Circle's fee can move a little.
// Accept a rise up to this much then instead of stopping after the swap (paying with USDC: none).
const USDT_FEE_TOLERANCE = 10_000n; // 0.01 USDC
// SOL the transfer needs: rent for the account where CCTP records the message (0.00299 SOL,
// reclaimable after 5 days), network fees, and for USDT the swap fee plus a USDC account if missing.
const LAMPORTS = { eventRent: 2_990_000n, fees: 100_000n, swap: 600_000n, usdcAccount: 2_040_000n };
const PENDING_KEY = 'sol2base:pendingBurn';
const RECIPIENT_KEY = 'sol2base:recipient';
// Burns made from this browser (or found in recent history), per Solana owner: { [owner]: [{ sig, event }] }.
// The public RPCs can't search old history or list accounts by owner, so the page remembers them to
// reclaim the message-account rent after 5 days.
const BURNS_KEY = 'sol2base:burns';
const FORM_KEY = 'sol2base:form'; // the form's choices, restored on reload
const BASE_WALLET_KEY = 'sol2base:baseWallet'; // 'injected' when an extension Base wallet was connected
// Set while a WalletConnect session is in use. WalletConnect keeps the session itself in IndexedDB, so
// this tells the page to load WalletConnect on start and restore it.
// (Its name must not contain "walletconnect", "wc@", "wc_" or "wallet_connect": WalletConnect moves such
// localStorage keys into its IndexedDB and deletes them.)
const WC_KEY = 'sol2base:qrSession';
// Public Solana RPCs that answer browser requests; the first one that works is used.
const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
// Reown (WalletConnect) project, shared with eth2base; Solana mainnet's CAIP-2 chain id.
const WALLETCONNECT_PROJECT_ID = 'c001d9e3d0c6308a5ce7e5932d40064a';
const WC_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const $ = (id) => document.getElementById(id);
let wallet = null; // { name, signTransaction(VersionedTransaction) → VersionedTransaction }
let owner = null; // PublicKey
let fees = null; // { fast: { bps, forward }, standard: { bps, forward } }, forward in USDC base units
let bal = null; // { usdc, usdt, sol, usdcAccount }: base units, lamports, whether the USDC account exists
let busy = false; // a transfer started from the form is in progress
let evm = null; // Base wallet { address, wallet, ensureBase, name }: needed for EURC (it signs the swap)
let baseBal = null; // { usdc, eurc, eth, gasPrice } of the Base wallet
let topUpTouched = false; // the user ticked/unticked the top-up; otherwise it follows the Base gas balance
let preferredOut = 'USDC'; // the user's choice; EURC is re-selected once a Base wallet makes it available
let topUpEth = null; // ETH that B.TOPUP_USDC buys right now, for the label
let pendingSwap = null; // { amountIn, to, topUp, sent, sentAmount, before, fee } for the EURC swap
// Pre-tick the top-up when Base ETH covers fewer than this many EURC swaps at the current gas price.
const TOPUP_BELOW_SWAPS = 4n;

// ---------- helpers ----------

const fmt = (v) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtSol = (v) => (Number(v) / 1e9).toLocaleString(undefined, { maximumSignificantDigits: 4 });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const solTx = (s) => `<a href="https://solscan.io/tx/${s}" target="_blank" rel="noopener">${short(s)}</a>`;
const baseTx = B.baseTx;
const fmtEth = (v) => (Number(v) / 1e18).toLocaleString(undefined, { maximumSignificantDigits: 4 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const errMsg = (e) => e?.message || String(e);
const currentMode = () => document.querySelector('input[name=mode]:checked').value;
const currentSrc = () => document.querySelector('input[name=src]:checked').value;
const currentOut = () => document.querySelector('input[name=out]:checked').value;
const topUpOn = () => currentOut() === 'EURC' && $('topUp').checked;

function parseAmount() {
  const v = $('amount').value.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(v)) return null;
  const [i, d = ''] = v.split('.');
  const amt = BigInt(i) * 1_000_000n + BigInt(d.padEnd(6, '0'));
  return amt > 0n ? amt : null;
}

// The Base address entered, else the connected Base wallet.
function recipient() {
  const v = $('recipient').value.trim();
  if (!v) return evm?.address ?? null;
  return isAddress(v) ? getAddress(v) : null;
}

let rpcIndex = 0;
async function rpc(method, params) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIndex + i) % RPCS.length];
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await res.json();
      if (j.error) {
        // A transaction or simulation error is an answer, not an endpoint problem.
        if (method === 'sendTransaction' || method === 'simulateTransaction') throw Object.assign(new Error(j.error.message), { rpc: true });
        throw new Error(j.error.message);
      }
      rpcIndex = (rpcIndex + i) % RPCS.length;
      return j.result;
    } catch (e) {
      if (e.rpc) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

// SPL token account amount (u64 at offset 64), or null when the account doesn't exist.
function tokenAmount(acct) {
  if (!acct) return null;
  const bytes = Uint8Array.from(atob(acct.data[0]), (c) => c.charCodeAt(0));
  return new DataView(bytes.buffer).getBigUint64(64, true);
}

// ---------- status, steps, notifications ----------

function setStatus(html, kind = '') {
  $('status').className = 'status ' + kind;
  $('status').innerHTML = html;
  notify($('status').textContent);
}

let swReg = null;
navigator.serviceWorker?.register('sw.js').then((r) => { swReg = r; }).catch((e) => console.warn('service worker', e));
async function askNotifications() {
  try {
    if (window.Notification?.permission === 'default') await Notification.requestPermission();
  } catch {}
}
// While the user is in their wallet app the page is in the background: mirror status changes into
// one notification (replaced each time). Android Chrome only supports this through a service worker.
function notify(text) {
  if (!document.hidden || !swReg || window.Notification?.permission !== 'granted') return;
  const body = text.split(/(?<=[.…])\s/)[0];
  swReg.showNotification('sol2base', { body, tag: 'sol2base', renotify: true, icon: 'icon.png' }).catch(() => {});
}
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !swReg) return;
  for (const n of await swReg.getNotifications({ tag: 'sol2base' })) n.close();
});

function setStep(name, state) {
  const li = document.querySelector(`#steps li[data-step="${name}"]`);
  li.classList.remove('active', 'done', 'skipped');
  if (state) li.classList.add(state);
  if (state === 'active') {
    li.dataset.start = Date.now();
    tickSteps();
  }
}
function tickSteps() {
  for (const li of document.querySelectorAll('#steps li.active')) {
    const secs = Math.floor((Date.now() - Number(li.dataset.start)) / 1000);
    let el = li.querySelector('.elapsed');
    if (!el) {
      el = document.createElement('span');
      el.className = 'elapsed';
      li.append(el);
    }
    el.textContent = ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
}
setInterval(tickSteps, 1000);
function resetSteps() {
  for (const li of document.querySelectorAll('#steps li')) {
    li.className = '';
    li.hidden = false;
    li.querySelector('.elapsed')?.remove();
  }
  document.querySelector('#steps li[data-step="swapIn"]').hidden = currentSrc() !== 'USDT';
  document.querySelector('#steps li[data-step="swap"]').hidden = currentOut() !== 'EURC';
  $('retrySwap').hidden = true;
  pendingSwap = null;
  $('progress').hidden = false;
}

// ---------- fees and quotes ----------

async function loadFees() {
  try {
    const list = await (await fetch(`${IRIS}/v2/burn/USDC/fees/${S.DOMAIN_SOLANA}/${S.DOMAIN_BASE}?forward=true`)).json();
    const pick = (threshold) => {
      const f = list.find((x) => x.finalityThreshold === threshold);
      if (!f?.forwardFee) throw new Error('missing forward fee');
      return { bps: f.minimumFee, forward: BigInt(f.forwardFee.high) };
    };
    fees = { fast: pick(FINALITY.fast), standard: pick(FINALITY.standard) };
  } catch (e) {
    console.warn('fee fetch failed', e);
    refreshForm();
    return false; // keep the last good fees on screen
  }
  refreshForm();
  return true;
}

// Max total fee (CCTP protocol fee + Circle forwarding fee, "high" tier) in USDC base units.
// Circle charges the full maxFee when forwarding; it is deducted from the burned amount on Base.
function maxFeeFor(amount, mode, f = fees) {
  const { bps, forward } = f[mode];
  return (amount * BigInt(Math.ceil(bps * 100)) + 999_999n) / 1_000_000n + forward;
}

// Latest USDT → USDC quote for the form: { key, quote, at } or { key, error, at }.
let usdtQuote = null;
let usdtQuoteTimer = null;
let usdtQuoteFor = null;
function requestUsdtQuote(amt) {
  if (usdtQuoteFor === amt) return;
  clearTimeout(usdtQuoteTimer);
  usdtQuoteTimer = setTimeout(async () => {
    usdtQuoteFor = amt;
    try {
      usdtQuote = { key: amt, quote: await S.jupiterQuote(amt, SLIPPAGE_BPS), at: Date.now() };
    } catch (e) {
      if (usdtQuote?.key !== amt || usdtQuote.error) usdtQuote = { key: amt, error: true, at: Date.now() };
    } finally {
      usdtQuoteFor = null;
    }
    if (parseAmount() === amt && currentSrc() === 'USDT') refreshForm();
  }, 400);
}

// End-to-end EUR/USD: USDC (or USDT) sent from Solana per EURC received on Base, all fees included.
const eurUsd = (sent, eurcOut) => (Number(sent) / Number(eurcOut)).toFixed(4);
let quoteSeq = 0;
let quoteTimer = null;
let shownQuoteKey = null; // source:amount:speed:topUp the displayed EURC quote was computed for
function showEurcQuote(sent, usdcIn, key, usdtNote, topUp) {
  const seq = ++quoteSeq;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    let text;
    let quoted = false;
    try {
      const [{ amountOut }, eth] = await Promise.all([B.quoteEurc(usdcIn - topUp), topUp ? B.quoteTopUp() : null]);
      quoted = true;
      const via = usdtNote ? `${usdtNote}, then about` : 'at least';
      const gasNote = eth ? `, plus about ${fmtEth(eth.amountOut)} ETH for gas from ${fmt(topUp)} USDC, not counted in the rate` : '';
      text = `You receive about ${fmt(amountOut)} EURC on Base. Effective EUR/USD ${eurUsd(sent - topUp, amountOut)}, all fees included (${via} ${fmt(usdcIn - topUp)} USDC swapped at the current Aerodrome rate, max 0.5% slippage${gasNote})`;
    } catch (e) {
      if (key === shownQuoteKey) return; // keep the last good quote for this input
      text = 'Could not get an Aerodrome quote right now.';
    }
    if (seq !== quoteSeq) return;
    $('receive').textContent = text;
    shownQuoteKey = quoted ? key : null;
  }, 400);
}

// SOL this transfer needs, in lamports.
function solNeeded(src) {
  return LAMPORTS.eventRent + LAMPORTS.fees + (src === 'USDT' ? LAMPORTS.swap + (bal?.usdcAccount ? 0n : LAMPORTS.usdcAccount) : 0n);
}

function refreshForm() {
  if (busy) return; // keep the form as submitted while a transfer runs
  quoteSeq++; // drop any in-flight EURC quote
  const src = currentSrc();

  // EURC needs a Base wallet that can pay gas for the swap (more with the top-up) at the current price.
  const eurcRadio = document.querySelector('input[name=out][value=EURC]');
  const swapGas = baseBal ? B.GAS_UNITS.swap * baseBal.gasPrice : 0n;
  const eurcOk = !!evm && (!baseBal || baseBal.eth >= swapGas);
  // Unknown until the Base balances load: leave the box as it is meanwhile.
  const topUpOk = !baseBal || baseBal.eth >= (B.GAS_UNITS.swap + B.GAS_UNITS.topUp) * baseBal.gasPrice;
  eurcRadio.disabled = !eurcOk;
  if (eurcOk && preferredOut === 'EURC') eurcRadio.checked = true;
  $('sweep').hidden = !evm || !baseBal?.usdc;
  $('sweep').disabled = !eurcOk;
  if (!eurcOk && eurcRadio.checked) document.querySelector('input[name=out][value=USDC]').checked = true;
  $('eurcHint').textContent = !evm ? '· needs a connected Base wallet with a little ETH for gas'
    : eurcOk ? '· needs a little ETH on Base for gas'
      : `· needs ETH on Base for gas: you have ${fmtEth(baseBal.eth)}, the swap takes about ${fmtEth(swapGas)}`;
  $('topUp').disabled = !topUpOk;
  if (!topUpOk) $('topUp').checked = false;
  else if (!topUpTouched && baseBal) $('topUp').checked = baseBal.eth < TOPUP_BELOW_SWAPS * swapGas;
  if (topUpEth) $('topUpEth').textContent = `about ${fmtEth(topUpEth)} ETH`;
  $('topUpRow').hidden = currentOut() !== 'EURC';
  const topUp = topUpOn() ? B.TOPUP_USDC : 0n;
  $('recipientLabel').textContent = currentOut() === 'EURC' ? 'EURC recipient on Base' : 'Recipient on Base';
  $('recipient').placeholder = evm ? `defaults to your Base wallet ${short(evm.address)}` : '0x… your Base (EVM) address';
  // Say whose address the recipient is.
  const typed = $('recipient').value.trim();
  $('recipientHint').textContent = !typed
    ? (evm ? `Using your connected Base wallet (${evm.name}).` : '')
    : !isAddress(typed) ? ''
      : evm && getAddress(typed) === evm.address ? `This is your connected Base wallet (${evm.name}).`
        : evm ? `Not your connected Base wallet (${short(evm.address)}): make sure you control this address.`
          : 'Make sure you control this address on Base.';
  const amt = parseAmount();
  $('amountLabel').textContent = `Amount (${src})`;

  let usdc = amt;
  let usdtNote = '';
  if (src === 'USDT' && amt) {
    const q = usdtQuote?.key === amt ? usdtQuote : null;
    if (!q || Date.now() - q.at > 30_000) requestUsdtQuote(amt); // keeps showing q meanwhile
    usdc = q && !q.error ? BigInt(q.quote.outAmount) : null;
    if (usdc) usdtNote = `${fmt(amt)} USDT → about ${fmt(usdc)} USDC via Jupiter`;
  }

  for (const mode of ['fast', 'standard']) {
    const fee = fees ? maxFeeFor(usdc ?? 0n, mode) : null;
    $(mode === 'fast' ? 'feeFast' : 'feeStd').textContent = fee === null ? ''
      : `· fee ≤ ${fmt(fee + (src === 'USDT' ? USDT_FEE_TOLERANCE : 0n))} USDC`;
  }

  let label = 'Bridge to Base';
  let ok = !!owner && !!amt && !!fees && !!recipient();
  let receive = '';
  if (!fees) {
    label = 'Loading fees…';
  } else if (amt && !usdc) {
    ok = false;
    label = usdtQuote?.key === amt && usdtQuote.error ? 'No USDT → USDC route right now' : 'Getting USDT → USDC quote…';
  } else if (amt) {
    const fee = maxFeeFor(usdc, currentMode());
    if (usdc <= fee + 2n * topUp) {
      ok = false;
      label = topUp ? 'Amount too small for the fee and the gas top-up' : 'Amount must be larger than the fee';
    } else if (currentOut() === 'EURC') {
      // Keep the shown quote while it refreshes for the same input, so the layout doesn't jump.
      const key = `${src}:${amt}:${currentMode()}:${topUp}`;
      receive = key === shownQuoteKey ? $('receive').textContent : 'Getting Aerodrome quote…';
      showEurcQuote(amt, usdc - fee, key, usdtNote, topUp);
    } else {
      receive = usdtNote
        ? `You receive about ${fmt(usdc - fee)} USDC on Base (${usdtNote}, then Circle's fee)`
        : `You receive at least ${fmt(usdc - fee)} USDC on Base`;
    }
  }
  if (receive !== $('receive').textContent) $('receive').textContent = receive;
  if (!receive.includes('EURC')) shownQuoteKey = null;

  let solWarn = '';
  if (owner && amt && bal) {
    const balance = src === 'USDT' ? bal.usdt : bal.usdc;
    if (amt > balance) {
      ok = false;
      label = `Insufficient ${src} on Solana`;
    } else if (bal.sol < solNeeded(src)) {
      ok = false;
      label = 'Not enough SOL';
      solWarn = `This needs about ${fmtSol(solNeeded(src))} SOL (mostly rent for Circle's message account, reclaimable after 5 days); you have ${fmtSol(bal.sol)}.`;
    }
  }
  if (owner && amt && !recipient()) label = $('recipient').value.trim() ? 'Recipient is not a valid Base address' : 'Enter the Base recipient';
  if (solWarn !== $('solWarn').textContent) $('solWarn').textContent = solWarn;
  $('bridge').disabled = !ok;
  $('bridge').textContent = label;
}

// ---------- wallet ----------

// Solana wallets announce themselves through the Wallet Standard (Phantom, Solflare, Backpack, Trust…).
// It passes transactions as bytes, so it works whatever Solana library the wallet uses; the older
// injected objects (window.phantom.solana etc.) are only a fallback.
const standardWallets = [];
const registerWallet = (w) => {
  if (w.features?.['solana:signTransaction'] && w.features?.['standard:connect'] && w.chains?.some((c) => c.startsWith('solana:'))) {
    standardWallets.push(w);
  }
};
window.addEventListener('wallet-standard:register-wallet', ({ detail: callback }) => callback({ register: registerWallet }));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: registerWallet } }));

const findInjected = () => window.phantom?.solana ?? window.solflare ?? window.backpack?.solana ?? window.trustwallet?.solana ?? window.solana ?? null;

async function connectStandard(w, silent) {
  const { accounts } = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
  const account = accounts?.[0] ?? w.accounts[0];
  if (!account) throw new Error('No account');
  wallet = {
    name: w.name,
    // Pass the wallet's own account object: some wallets (Trust) check it by identity.
    signTransaction: async (tx) => {
      const [{ signedTransaction }] = await w.features['solana:signTransaction'].signTransaction({ account, transaction: tx.serialize(), chain: 'solana:mainnet' });
      return S.VersionedTransaction.deserialize(signedTransaction);
    },
  };
  setOwner(new S.PublicKey(account.address));
  w.features['standard:events']?.on('change', ({ accounts }) => {
    if (accounts) setOwner(accounts[0] ? new S.PublicKey(accounts[0].address) : null);
  });
}

async function connectInjected(p, silent) {
  const res = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
  const pk = res?.publicKey ?? p.publicKey;
  wallet = {
    name: p.isPhantom ? 'Phantom' : p.isSolflare ? 'Solflare' : 'wallet',
    signTransaction: async (tx) => S.VersionedTransaction.deserialize((await p.signTransaction(tx)).serialize()),
  };
  setOwner(pk ? new S.PublicKey(pk.toString()) : null);
  p.on?.('accountChanged', (pk) => setOwner(pk ? new S.PublicKey(pk.toString()) : null));
  p.on?.('disconnect', () => setOwner(null));
}

// Base58 → bytes (for signatures returned over WalletConnect).
function base58Decode(s) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(alphabet.indexOf(ch));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// A phone wallet over WalletConnect: QR code on desktop, wallet list or link on phones.
let wcClient = null;
async function wcInit() {
  if (wcClient) return wcClient;
  const { SignClient } = await import('https://esm.sh/@walletconnect/sign-client@2.17.2');
  wcClient = await SignClient.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    // The page's own URL (not just the origin, which is a different site with its own favicon), so wallets
    // that look up the site's icon find this one.
    metadata: { name: 'sol2base', description: 'Bridge USDT/USDC from Solana to Base with CCTP', url: new URL('.', location.href).href, icons: [new URL('icon.png', location.href).href] },
  });
  wcClient.on('session_delete', () => {
    try { localStorage.removeItem(WC_KEY); } catch {}
    setOwner(null);
    setEvm(null);
  });
  return wcClient;
}

// A stored, still-valid WalletConnect session with a Solana account (sessions survive reloads).
const wcStoredSession = (client) => client.session.getAll()
  .filter((s) => s.namespaces.solana?.accounts.length && s.expiry * 1000 > Date.now())
  .sort((a, b) => b.expiry - a.expiry)[0];

// On load: reuse a stored session without showing a QR code.
async function restoreWalletConnect() {
  if (!localStorage.getItem(WC_KEY)) return false;
  const client = await wcInit();
  const session = wcStoredSession(client);
  if (!session) {
    try { localStorage.removeItem(WC_KEY); } catch {} // expired or ended in the wallet
    return false;
  }
  useWalletConnectSession(client, session);
  return true;
}

async function connectWalletConnect() {
  const [client, { WalletConnectModal }] = await Promise.all([wcInit(), import('https://esm.sh/@walletconnect/modal@2.7.0')]);
  const modal = new WalletConnectModal({ projectId: WALLETCONNECT_PROJECT_ID, chains: [WC_SOLANA] });
  const { uri, approval } = await client.connect({
    requiredNamespaces: { solana: { chains: [WC_SOLANA], methods: ['solana_signTransaction'], events: [] } },
    optionalNamespaces: {
      // Lets the wallet broadcast single-signer transactions itself (see sendWatched).
      solana: { chains: [WC_SOLANA], methods: ['solana_signAndSendTransaction'], events: [] },
      // The same wallet's Base account, if it has one: recipient, and signer of the EURC swap.
      eip155: { chains: ['eip155:8453'], methods: ['eth_sendTransaction'], events: ['accountsChanged', 'chainChanged'] },
    },
  });
  if (uri) modal.openModal({ uri });
  let session;
  try {
    session = await approval();
  } finally {
    modal.closeModal();
  }
  useWalletConnectSession(client, session);
}

function useWalletConnectSession(client, session) {
  try { localStorage.setItem(WC_KEY, '1'); } catch {}
  const address = session.namespaces.solana.accounts[0].split(':')[2];
  const pk = new S.PublicKey(address);
  wallet = {
    name: session.peer.metadata.name,
    signTransaction: async (tx) => {
      const res = await client.request({
        topic: session.topic, chainId: WC_SOLANA,
        request: { method: 'solana_signTransaction', params: { transaction: b64(tx.serialize()) } },
      });
      if (res.transaction) return S.VersionedTransaction.deserialize(Uint8Array.from(atob(res.transaction), (c) => c.charCodeAt(0)));
      tx.addSignature(pk, base58Decode(res.signature));
      return tx;
    },
    // Only if the wallet approved it; resolves to the signature once the wallet has sent it.
    signAndSend: session.namespaces.solana.methods.includes('solana_signAndSendTransaction')
      ? async (tx) => (await client.request({
        topic: session.topic, chainId: WC_SOLANA,
        request: { method: 'solana_signAndSendTransaction', params: { transaction: b64(tx.serialize()) } },
      })).signature
      : null,
  };
  setOwner(pk);
  const baseAccount = session.namespaces.eip155?.accounts.find((a) => a.startsWith('eip155:8453:'));
  if (baseAccount) setEvm({ ...B.walletConnectBaseWallet(client, session.topic, baseAccount.split(':')[2]), name: session.peer.metadata.name });
}

async function connect(silent = false) {
  if (standardWallets.length) return connectStandard(standardWallets[0], silent);
  const p = findInjected();
  if (p) return connectInjected(p, silent);
  if (!silent) $('noWallet').hidden = false;
}

function setOwner(pk) {
  owner = pk;
  $('account').textContent = owner ? `Connected${wallet?.name ? ` (${wallet.name})` : ''}: ${short(owner.toBase58())}` : 'Not connected';
  $('connect').textContent = owner ? 'Connected' : 'Connect Solana wallet';
  $('connect').disabled = !!owner;
  $('connectQr').hidden = !!owner;
  $('balances').hidden = !owner;
  $('noWallet').hidden = true;
  refreshBalances();
  if (owner) discoverBurns().then(refreshRent).catch((e) => console.warn('burn history', e));
  else $('rentRow').hidden = true;
}

async function refreshBalances() {
  if (!owner) { bal = null; refreshForm(); return; }
  try {
    const usdcAta = S.ata(owner, S.USDC_MINT).toBase58(), usdtAta = S.ata(owner, S.USDT_MINT).toBase58();
    const [{ value: accts }, { value: sol }] = await Promise.all([
      rpc('getMultipleAccounts', [[usdcAta, usdtAta], { encoding: 'base64', commitment: 'confirmed' }]),
      rpc('getBalance', [owner.toBase58(), { commitment: 'confirmed' }]),
    ]);
    bal = { usdc: tokenAmount(accts[0]) ?? 0n, usdt: tokenAmount(accts[1]) ?? 0n, sol: BigInt(sol), usdcAccount: !!accts[0] };
    $('balUsdc').textContent = fmt(bal.usdc);
    $('balUsdt').textContent = fmt(bal.usdt);
    $('balSol').textContent = fmtSol(bal.sol);
  } catch (e) {
    console.warn('balances', e);
  }
  refreshForm();
}

const inWallet = () => `in ${wallet?.name && wallet.name !== 'wallet' ? wallet.name : 'your wallet'}`;
const inBaseWallet = () => `in ${evm?.name ?? 'your Base wallet'}`;

async function connectBase() {
  if (!window.ethereum) { alert('No Base (EVM) wallet found in this browser. Use WalletConnect to connect a phone wallet such as Trust Wallet, which covers both Solana and Base.'); return; }
  const w = await B.injectedBaseWallet(window.ethereum);
  setEvm({ ...w, name: window.ethereum.isRabby ? 'Rabby' : window.ethereum.isPhantom ? 'Phantom' : window.ethereum.isMetaMask ? 'MetaMask' : 'your Base wallet' });
  try { localStorage.setItem(BASE_WALLET_KEY, 'injected'); } catch {}
  window.ethereum.on?.('accountsChanged', (accs) => (accs[0] ? connectBase() : setEvm(null)));
}

function setEvm(e) {
  evm = e;
  $('evmAccount').textContent = evm ? `Base wallet (${evm.name}): ${short(evm.address)}` : 'Base wallet: not connected (needed for EURC)';
  $('connectBase').hidden = !!evm;
  $('baseBalances').hidden = !evm;
  refreshBaseBalances();
}

async function refreshBaseBalances() {
  if (!evm) { baseBal = null; refreshForm(); return; }
  try {
    baseBal = await B.baseBalances(evm.address);
    $('balBaseUsdc').textContent = fmt(baseBal.usdc);
    $('balEurc').textContent = fmt(baseBal.eurc);
    $('gasBase').textContent = fmtEth(baseBal.eth);
    $('sweep').textContent = `Swap all ${fmt(baseBal.usdc)} Base USDC to EURC`;
    topUpEth = (await B.quoteTopUp()).amountOut;
  } catch (e) {
    console.warn('base balances', e);
  }
  refreshForm();
}

// Have the wallet sign (then any extra signers), send it ourselves (re-sending until it lands), and
// wait for confirmation. Throws if it fails on chain or expires unconfirmed (then nothing was spent).
async function signAndSend(tx, lastValidBlockHeight, label, extraSigners = []) {
  // If the wallet doesn't answer for a minute, say so rather than looking stuck.
  const slow = setTimeout(() => setStatus(`Still waiting for ${wallet?.name ?? 'the wallet'} to return the signed ${label.toLowerCase()}. If you already confirmed, switch back to the wallet and check it; if you rejected it, reload the page.`), 60_000);
  let signed;
  try {
    signed = await wallet.signTransaction(tx);
  } finally {
    clearTimeout(slow);
  }
  if (extraSigners.length) signed.sign(extraSigners);
  const raw = b64(signed.serialize());
  const sig = await rpc('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 }]);
  setStatus(`${label} sent ${solTx(sig)}, waiting for confirmation…`);
  for (;;) {
    await sleep(2000);
    const { value: [st] } = await rpc('getSignatureStatuses', [[sig]]);
    if (st?.err) throw new Error(`${label} failed on Solana: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    if ((await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) {
      throw new Error(`${label} expired before it was confirmed; nothing was spent. Try again.`);
    }
    rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {});
  }
}

// For single-signer transactions over WalletConnect: let the wallet sign and send, and watch the chain
// for the result, since the wallet's reply (the signature) can get lost on the way back. check()
// returns true once the transaction's effect is visible. Throws if it expires without landing.
async function sendWatched(tx, lastValidBlockHeight, label, check) {
  const slow = setTimeout(() => setStatus(`Still waiting for ${wallet?.name ?? 'the wallet'} to send the ${label.toLowerCase()}. Keep the wallet app open; this page also watches Solana and moves on when it lands.`), 60_000);
  let watching = true;
  const sent = wallet.signAndSend(tx).then((sig) => { if (watching) setStatus(`${label} sent ${solTx(sig)}, waiting for confirmation…`); return sig; });
  sent.catch(() => {}); // a rejection still reaches the race below
  const seen = (async () => {
    while (watching) {
      await sleep(3000);
      try {
        if (await check()) return true;
        if ((await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) {
          throw new Error(`${label} expired before it landed; nothing was spent. Click Bridge to try again.`);
        }
      } catch (e) {
        if (/expired/.test(e.message)) throw e;
        console.warn('chain watch failed', e);
      }
    }
    return new Promise(() => {});
  })();
  try {
    // A returned signature isn't enough: wait until the effect is on chain too.
    await Promise.race([sent.then(async () => { while (!(await check())) await sleep(2000); }), seen]);
  } finally {
    watching = false;
    clearTimeout(slow);
  }
}

// WalletConnect gives up on a request after 5 minutes without a reply from the wallet.
function explain(e) {
  const m = errMsg(e);
  return /request expired/i.test(m)
    ? `${wallet?.name ?? 'The wallet'} didn't send its reply back in time, so the request expired. Nothing was sent. Click Bridge to try again, and keep the wallet app open until this page moves on.`
    : m;
}

// ---------- flow ----------

// Swap USDT → USDC with Jupiter after checking the swap by simulation. Resolves to the USDC received.
async function swapUsdtToUsdc(amountIn) {
  setStep('swapIn', 'active');
  setStatus('Getting a Jupiter route…');
  const quote = await S.jupiterQuote(amountIn, SLIPPAGE_BPS);
  const minOut = BigInt(quote.otherAmountThreshold);
  // Sanity floor independent of Jupiter: USDT and USDC trade near 1:1.
  if (minOut < (amountIn * 98n) / 100n) throw new Error('Jupiter quote is too far from 1:1');
  const { tx, lastValidBlockHeight } = await S.jupiterSwapTx(quote, owner);
  await S.checkSwapBySimulation(rpc, tx, owner, amountIn, minOut);
  const before = tokenAmount((await rpc('getMultipleAccounts', [[S.ata(owner, S.USDC_MINT).toBase58()], { encoding: 'base64', commitment: 'confirmed' }])).value[0]) ?? 0n;
  setStatus(`Confirm the swap of ${fmt(amountIn)} USDT for about ${fmt(BigInt(quote.outAmount))} USDC ${inWallet()}…`);
  const usdcNow = async () => tokenAmount((await rpc('getMultipleAccounts', [[S.ata(owner, S.USDC_MINT).toBase58()], { encoding: 'base64', commitment: 'confirmed' }])).value[0]) ?? 0n;
  if (wallet.signAndSend) await sendWatched(tx, lastValidBlockHeight, 'Swap', async () => (await usdcNow()) >= before + minOut);
  else await signAndSend(tx, lastValidBlockHeight, 'Swap');
  const after = await usdcNow();
  const received = after - before;
  if (received <= 0n) throw new Error('The swap delivered no USDC');
  setStep('swapIn', 'done');
  return received;
}

async function bridge() {
  let amount = parseAmount();
  const out = currentOut();
  if (out === 'EURC' && !evm) return;
  // For EURC the USDC is minted to the Base wallet, which signs the swap; the recipient only gets the EURC.
  const to = out === 'EURC' ? evm.address : recipient();
  const eurcTo = out === 'EURC' ? recipient() : null;
  const topUp = topUpOn();
  if (!amount || !fees || !to || !owner) return;
  const src = currentSrc();
  const shownUsdc = src === 'USDT' ? (usdtQuote?.key === amount && !usdtQuote.error ? BigInt(usdtQuote.quote.outAmount) : null) : amount;
  if (!shownUsdc) return;
  await askNotifications();
  const mode = currentMode();
  try { if ($('recipient').value.trim()) localStorage.setItem(RECIPIENT_KEY, recipient()); } catch {}

  $('bridge').disabled = true;
  resetSteps();
  busy = true;
  const shownFees = fees;
  let source = null; // { amount } when the transfer started from USDT
  let unburned = null; // USDC from the USDT swap that hasn't been burned yet
  try {
    // 0. USDT → USDC
    if (src === 'USDT') {
      const received = await swapUsdtToUsdc(amount);
      source = { amount };
      amount = received;
      unburned = received;
      refreshBalances();
    }

    // Never charge more than the fee the user saw (plus the USDT tolerance): if it went up, stop.
    const allowedFee = maxFeeFor(amount, mode, shownFees) + (source ? USDT_FEE_TOLERANCE : 0n);
    if (!(await loadFees())) throw new Error('Could not load current fees from Circle. Try again.');
    const maxFee = maxFeeFor(amount, mode);
    if (maxFee > allowedFee) {
      throw new Error(`${source ? `Swapped to ${fmt(amount)} USDC. ` : ''}Circle's fee just went up from ${fmt(allowedFee)} to ${fmt(maxFee)} USDC. Click Bridge again to accept it.`);
    }
    if (amount <= maxFee) throw new Error('Amount must be larger than the fee.');

    // 1. Burn on Solana with the forwarding hook, so Circle mints on Base
    setStep('burn', 'active');
    const { value: { blockhash, lastValidBlockHeight } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const { tx, eventKeypair } = S.buildBurnTx({ owner, amount, mintRecipient: to, maxFee, minFinalityThreshold: FINALITY[mode], blockhash });
    const sim = await rpc('simulateTransaction', [b64(tx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }]);
    if (sim.value.err) throw new Error(`The burn would fail: ${JSON.stringify(sim.value.err)}`);
    setStatus(`Confirm the burn of ${fmt(amount)} USDC ${inWallet()}…`);
    const sig = await signAndSend(tx, lastValidBlockHeight, 'Burn', [eventKeypair]);
    rememberBurn(owner.toBase58(), sig, eventKeypair.publicKey.toBase58());
    unburned = null;
    savePending({ sig, out, eurcTo, topUp });
    setStep('burn', 'done');
    refreshBalances();

    await finish(await track(sig, mode), source, out, eurcTo, topUp);
  } catch (e) {
    console.error(e);
    setStatus(explain(e), 'err');
    // Stopped after the USDT swap but before the burn: set the form to bridge that USDC.
    if (unburned) {
      document.querySelector('input[name=src][value=USDC]').checked = true;
      $('amount').value = (Number(unburned) / 1e6).toFixed(6).replace(/\.?0+$/, '');
    }
  } finally {
    busy = false;
    refreshForm();
  }
}

async function resume() {
  const sig = $('resumeSig').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) { alert('Enter a valid Solana transaction signature.'); return; }
  await askNotifications();
  resetSteps();
  setStep('burn', 'done');
  const saved = loadPending();
  const same = saved?.sig === sig;
  try {
    await finish(await track(sig), null, same ? saved.out : currentOut(), same ? saved.eurcTo : recipient(), same ? saved.topUp : topUpOn());
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
  }
}

// Poll Circle until the forwarder has minted on Base. Resolves to the message.
async function track(sig, mode) {
  setStep('attest', 'active');
  const wait = mode === 'fast' ? 'usually a few seconds' : mode === 'standard' ? 'usually under a minute' : 'this can take a while';
  setStatus(`Waiting for Circle to attest the burn (${wait}). You can close this page and resume later with ${solTx(sig)}.`);
  const url = `${IRIS}/v2/messages/${S.DOMAIN_SOLANA}?transactionHash=${sig}`;
  let attested = false;
  for (;;) {
    let m = null;
    try {
      const res = await fetch(url);
      if (res.ok) m = (await res.json()).messages?.[0] ?? null;
      else if (res.status !== 404) console.warn('attestation API', res.status, await res.text());
    } catch (e) {
      console.warn('attestation poll failed', e);
    }
    if (m?.decodedMessage && Number(m.decodedMessage.destinationDomain) !== S.DOMAIN_BASE) throw new Error('This burn is not destined for Base.');
    if (m?.forwardTxHash) {
      for (const s of ['attest', 'mint']) setStep(s, 'done');
      return m;
    }
    if (!attested && m?.status === 'complete') {
      attested = true;
      setStep('attest', 'done');
      setStep('mint', 'active');
      setStatus('Attested. Waiting for Circle to mint on Base…');
    }
    await sleep(4000);
  }
}

async function finish(m, source = null, out = 'USDC', eurcTo = null, topUp = false) {
  // An EURC transfer stays saved (for Resume after a reload) until its swap is done.
  if (out !== 'EURC') clearPending();
  refreshBalances();
  refreshBaseBalances();
  const body = m.decodedMessage?.decodedMessageBody;
  const link = baseTx(m.forwardTxHash);
  if (!body?.amount) {
    setStatus(out === 'EURC' ? `USDC minted on Base ${link}, but the transfer amount couldn't be read, so no swap was made.` : `Done! USDC minted on Base ${link}.`, out === 'EURC' ? 'err' : 'ok');
    return;
  }
  const burned = BigInt(body.amount);
  const fee = BigInt(body.feeExecuted ?? body.maxFee ?? 0);
  const minted = burned - fee;
  const to = getAddress(`0x${body.mintRecipient.slice(-40)}`);
  const sent = source ? `${fmt(source.amount)} USDT` : `${fmt(burned)} USDC`;
  const before = source ? `USDT → ${fmt(burned)} USDC via Jupiter, ` : '';
  const rent = `The ${fmtSol(LAMPORTS.eventRent)} SOL message-account rent can be reclaimed after 5 days.`;
  if (out !== 'EURC') {
    setStatus(`Done! ${sent} → ${fmt(minted)} USDC on Base for ${short(to)} ${link}. Fees: ${before}Circle's fee ${fmt(fee)} USDC. ${rent}`, 'ok');
    return;
  }
  // Swap only what this transfer delivered, never other USDC in the wallet.
  pendingSwap = { signer: to, amountIn: minted, to: eurcTo ?? to, topUp, sent, sentAmount: source?.amount ?? burned, before, fee, rent };
  setStatus(`${fmt(minted)} USDC minted on Base ${link}. Now swapping to EURC…`);
  await swapToEurc();
}

// Swap the bridged USDC to EURC, signed by the Base wallet the USDC was minted to.
async function swapToEurc() {
  if (!pendingSwap) return;
  const p = pendingSwap;
  $('retrySwap').hidden = true;
  setStep('swap', 'active');
  try {
    if (!evm) throw new Error('Connect your Base wallet to swap.');
    if (evm.address !== p.signer) throw new Error(`The USDC went to ${short(p.signer)}. Connect that Base wallet to swap.`);
    const r = await B.swapToEurc({ signer: evm, amountIn: p.amountIn, to: getAddress(p.to), topUp: p.topUp, setStatus, inWallet: inBaseWallet });
    setStep('swap', 'done');
    pendingSwap = null;
    clearPending();
    const dest = p.to === evm.address ? '' : ` for ${short(p.to)}`;
    const gasDone = r.ethOut ? `, plus ${fmtEth(r.ethOut)} ETH for gas from ${fmt(r.topUp)} USDC` : '';
    // The rate is only end-to-end if the whole delivered amount was swapped; it leaves out the gas top-up.
    setStatus(r.amountIn === p.amountIn
      ? `Done! ${p.sent} → ${fmt(r.eurcOut)} EURC${dest}${gasDone}. Effective EUR/USD ${eurUsd(p.sentAmount - r.topUp, r.eurcOut)}, all fees included (${p.before}Circle's fee ${fmt(p.fee)} USDC, then the Aerodrome swap ${baseTx(r.hash)}). ${p.rent}`
      : `Done! Swapped ${fmt(r.amountIn)} USDC to ${fmt(r.eurcOut)} EURC${dest}${gasDone} on Aerodrome ${baseTx(r.hash)}.`, 'ok');
    refreshBaseBalances();
  } catch (e) {
    console.error(e);
    setStatus(`Swap failed: ${errMsg(e)} Your USDC is safe on Base.`, 'err');
    $('retrySwap').hidden = false;
  }
}

// Swap the Base wallet's whole USDC balance to EURC (e.g. USDC left from earlier transfers).
async function sweep() {
  if (!evm || busy) return;
  busy = true;
  $('sweep').disabled = true;
  resetSteps();
  for (const li of document.querySelectorAll('#steps li')) li.hidden = li.dataset.step !== 'swap';
  setStep('swap', 'active');
  try {
    const { usdc } = await B.baseBalances(evm.address);
    if (!usdc) throw new Error('No USDC on Base to swap.');
    const to = recipient() ?? evm.address;
    const topUp = !$('topUp').disabled && $('topUp').checked;
    const r = await B.swapToEurc({ signer: evm, amountIn: usdc, to, topUp, setStatus, inWallet: inBaseWallet });
    setStep('swap', 'done');
    const dest = to === evm.address ? '' : ` for ${short(to)}`;
    const gasDone = r.ethOut ? `, plus ${fmtEth(r.ethOut)} ETH for gas from ${fmt(r.topUp)} USDC` : '';
    setStatus(`Done! Swapped ${fmt(r.amountIn - r.topUp)} USDC to ${fmt(r.eurcOut)} EURC${dest}${gasDone} on Aerodrome ${baseTx(r.hash)}. Rate: EUR/USD ${eurUsd(r.amountIn - r.topUp, r.eurcOut)}.`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(`Swap failed: ${explain(e)} Your USDC is safe on Base.`, 'err');
  } finally {
    busy = false;
    refreshBaseBalances();
  }
}

// ---------- message-account rent ----------

function loadBurns() { try { return JSON.parse(localStorage.getItem(BURNS_KEY) ?? '{}'); } catch { return {}; } }
function saveBurns(b) { try { localStorage.setItem(BURNS_KEY, JSON.stringify(b)); } catch {} }
function rememberBurn(ownerAddr, sig, event) {
  const b = loadBurns();
  const list = b[ownerAddr] ?? [];
  if (!list.some((x) => x.sig === sig)) list.push({ sig, event });
  b[ownerAddr] = list;
  saveBurns(b);
}

// Find CCTP burns in the owner's recent history (within what the public RPC keeps): the message
// account is the transaction's second signer.
async function discoverBurns() {
  const me = owner.toBase58();
  const known = new Set((loadBurns()[me] ?? []).map((x) => x.sig));
  const sigs = await rpc('getSignaturesForAddress', [me, { limit: 40 }]);
  for (const { signature, err } of sigs) {
    if (err || known.has(signature)) continue;
    let tx;
    try { tx = await rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); } catch { continue; }
    const keys = tx?.transaction.message.accountKeys ?? [];
    const isBurn = tx?.transaction.message.instructions.some((i) => keys[i.programIdIndex] === S.TOKEN_MESSENGER_MINTER_PROGRAM.toBase58());
    if (isBurn && tx.transaction.message.header.numRequiredSignatures >= 2 && keys[0] === me) rememberBurn(me, signature, keys[1]);
  }
}

let reclaimable = []; // [{ sig, event, lamports }] whose 5-day window has passed
async function refreshRent() {
  if (!owner) return;
  const me = owner.toBase58();
  const list = loadBurns()[me] ?? [];
  if (!list.length) { $('rentRow').hidden = true; return; }
  const { value: accts } = await rpc('getMultipleAccounts', [list.map((x) => x.event), { encoding: 'base64', commitment: 'confirmed' }]);
  const now = Date.now() / 1000;
  const open = [];
  reclaimable = [];
  let pendingLamports = 0n, nextAt = Infinity;
  list.forEach((x, i) => {
    const a = accts[i];
    if (!a || a.owner !== S.MESSAGE_TRANSMITTER_PROGRAM.toBase58()) return; // already reclaimed
    open.push(x);
    const { rentPayer, createdAt } = S.parseEventAccount(Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0)));
    if (rentPayer.toBase58() !== me) return;
    const at = createdAt + S.EVENT_ACCOUNT_WINDOW_SECONDS;
    if (now >= at) reclaimable.push({ ...x, lamports: BigInt(a.lamports) });
    else { pendingLamports += BigInt(a.lamports); nextAt = Math.min(nextAt, at); }
  });
  // Forget accounts that no longer exist.
  const b = loadBurns(); b[me] = open; saveBurns(b);
  const ready = reclaimable.reduce((s, x) => s + x.lamports, 0n);
  const parts = [];
  if (ready) parts.push(`${fmtSol(ready)} SOL message-account rent reclaimable (${reclaimable.length} transfer${reclaimable.length > 1 ? 's' : ''})`);
  if (pendingLamports) parts.push(`${fmtSol(pendingLamports)} SOL reclaimable from ${new Date(nextAt * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  $('rentText').textContent = parts.join('; ');
  $('rentRow').hidden = !parts.length;
  $('reclaim').hidden = !ready;
}

// Close the eligible message accounts, one transaction each, returning their rent to the owner.
async function reclaim() {
  if (busy || !reclaimable.length) return;
  busy = true;
  $('reclaim').disabled = true;
  resetSteps();
  for (const li of document.querySelectorAll('#steps li')) li.hidden = true;
  let done = 0n;
  try {
    for (const x of reclaimable) {
      const m = (await (await fetch(`${IRIS}/v2/messages/${S.DOMAIN_SOLANA}?transactionHash=${x.sig}`)).json()).messages?.[0];
      if (!m?.attestation || m.attestation === 'PENDING') throw new Error(`Circle has no attestation for ${short(x.sig)} yet.`);
      const { value: { blockhash, lastValidBlockHeight } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const tx = S.buildReclaimTx({ owner, eventAccount: new S.PublicKey(x.event), attestation: m.attestation, message: m.message, blockhash });
      const sim = await rpc('simulateTransaction', [b64(tx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }]);
      if (sim.value.err) throw new Error(`Reclaiming ${short(x.sig)} would fail: ${JSON.stringify(sim.value.err)}`);
      setStatus(`Confirm reclaiming ${fmtSol(x.lamports)} SOL ${inWallet()}…`);
      await signAndSend(tx, lastValidBlockHeight, 'Reclaim');
      done += x.lamports;
    }
    setStatus(`Done! Reclaimed ${fmtSol(done)} SOL of message-account rent.`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(`${done ? `Reclaimed ${fmtSol(done)} SOL so far. ` : ''}${explain(e)}`, 'err');
  } finally {
    busy = false;
    $('reclaim').disabled = false;
    refreshBalances();
    refreshRent();
  }
}

// ---------- persistence ----------

function savePending(p) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch {} }
function clearPending() { try { localStorage.removeItem(PENDING_KEY); } catch {} }
function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (raw.startsWith('{') ? JSON.parse(raw) : { sig: raw, out: 'USDC' }) : null;
  } catch { return null; }
}
function saveForm() {
  const v = (name) => document.querySelector(`input[name=${name}]:checked`).value;
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify({
      src: v('src'), amount: $('amount').value, out: preferredOut, mode: v('mode'), topUp: topUpTouched ? $('topUp').checked : null,
    }));
  } catch {}
}
function loadForm() {
  try {
    const f = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null');
    if (!f) return;
    const pick = (name, value) => { const el = document.querySelector(`input[name=${name}][value="${value}"]`); if (el) el.checked = true; };
    pick('src', f.src);
    pick('mode', f.mode);
    if (f.amount) $('amount').value = f.amount;
    preferredOut = f.out === 'EURC' ? 'EURC' : 'USDC';
    if (f.topUp !== null && f.topUp !== undefined) { topUpTouched = true; $('topUp').checked = f.topUp; }
  } catch {}
}

function loadSaved() {
  loadForm();
  try {
    const p = loadPending();
    if (p) {
      $('resumeSig').value = p.sig;
      $('resumeSig').closest('details').open = true;
      if (p.out === 'EURC') preferredOut = 'EURC';
    }
    const to = localStorage.getItem(RECIPIENT_KEY);
    if (to) $('recipient').value = to;
  } catch {}
}

// ---------- wire up ----------

$('connect').onclick = () => connect().catch((e) => alert(errMsg(e)));
$('connectQr').onclick = () => connectWalletConnect().catch((e) => alert(errMsg(e)));
$('connectBase').onclick = () => connectBase().catch((e) => alert(errMsg(e)));
$('retrySwap').onclick = swapToEurc;
$('sweep').onclick = sweep;
$('reclaim').onclick = reclaim;
$('topUp').onchange = () => { topUpTouched = true; refreshForm(); saveForm(); };
$('bridge').onclick = bridge;
$('resume').onclick = resume;
$('amount').oninput = () => { refreshForm(); saveForm(); };
$('recipient').oninput = () => {
  refreshForm();
  const r = $('recipient').value.trim();
  try { if (!r) localStorage.removeItem(RECIPIENT_KEY); else if (isAddress(r)) localStorage.setItem(RECIPIENT_KEY, getAddress(r)); } catch {}
};
$('max').onclick = () => {
  if (!bal) return;
  $('amount').value = (Number(currentSrc() === 'USDT' ? bal.usdt : bal.usdc) / 1e6).toString();
  refreshForm();
  saveForm();
};
for (const r of document.querySelectorAll('input[name=mode], input[name=src], input[name=out]')) {
  r.onchange = () => {
    if (r.name === 'out') preferredOut = r.value;
    refreshForm();
    saveForm();
  };
}
// On a phone without an injected wallet, open this page inside the wallet app's browser.
const here = encodeURIComponent(location.href);
$('openPhantom').href = `https://phantom.app/ul/browse/${here}?ref=${encodeURIComponent(location.origin)}`;
$('openSolflare').href = `https://solflare.com/ul/v1/browse/${here}?ref=${encodeURIComponent(location.origin)}`;
$('openTrust').href = `https://link.trustwallet.com/open_url?coin_id=501&url=${here}`; // 501 = Solana

if ($('commit').textContent.startsWith('__')) {
  $('commit').textContent = 'dev';
  $('commit').href = 'https://github.com/SwapMarket/sol2base';
}

loadSaved();
loadFees();
setInterval(() => { loadFees(); refreshBalances(); refreshBaseBalances(); refreshRent().catch(() => {}); }, 30_000);
// Wallets that remember this site connect without a prompt (after standard wallets have registered).
// Reconnect what was connected before: a stored WalletConnect session (both chains), else a wallet that
// remembers this site; and an extension Base wallet if one was connected (no prompt: eth_accounts).
setTimeout(async () => {
  const restored = await restoreWalletConnect().catch((e) => { console.warn('walletconnect restore', e); return false; });
  if (!restored) connect(true).catch(() => {});
  try {
    if (!evm && localStorage.getItem(BASE_WALLET_KEY) === 'injected' && (await window.ethereum?.request({ method: 'eth_accounts' }))?.length) {
      await connectBase();
    }
  } catch (e) { console.warn('base wallet restore', e); }
}, 300);
