import { isAddress, getAddress } from 'https://esm.sh/viem@2.21.55';
import * as S from 'solana';
import * as B from 'base';

const IRIS = 'https://iris-api.circle.com';
const FINALITY = { fast: 1000, standard: 2000 };
const SLIPPAGE_BPS = 50; // 0.5%
// Paying with USDT, the swap takes a moment during which Circle's fee can move a little.
// Accept a rise up to this much then instead of stopping after the swap (paying with USDC: none).
const USDT_FEE_TOLERANCE = 10_000n; // 0.01 USDC (also used paying with EURC, Base → Solana)
// SOL the transfer needs: rent for the account where CCTP records the message (0.00299 SOL,
// reclaimable after 5 days), network fees, and for USDT the swap fee plus a USDC account if missing.
const LAMPORTS = { eventRent: 2_990_000n, fees: 100_000n, swap: 600_000n, usdcAccount: 2_040_000n };
const PENDING_KEY = 'sol2base:pendingBurn';
const RECIPIENT_KEY = 'sol2base:recipient';
const RECIPIENT_SOL_KEY = 'sol2base:recipientSol'; // Solana recipient for Base → Solana
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
// Set when the user disconnected the Solana wallet, so a wallet that remembers this site isn't
// reconnected silently on the next load; cleared by connecting again.
const SOL_OFF_KEY = 'sol2base:solDisconnected';
// Public Solana RPCs that answer browser requests; the first one that works is used.
const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
// Reown (WalletConnect) project, shared with eth2base; Solana mainnet's CAIP-2 chain id.
const WALLETCONNECT_PROJECT_ID = 'c001d9e3d0c6308a5ce7e5932d40064a';
const WC_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const $ = (id) => document.getElementById(id);
let wallet = null; // { name, signTransaction(VersionedTransaction) → VersionedTransaction }
let owner = null; // PublicKey
// Per route: { fast: { bps, forward }, standard: { bps, forward } }, forward in USDC base units. toSolSetup
// is Base → Solana when Circle also creates the recipient's USDC account (its rent is in the fee).
let allFees = null; // { toBase, toSol, toSolSetup }
// Base → Solana recipient: { addr, needsAccount (no USDC account yet), tokenAccount (the address is itself
// a token account, not a wallet) }, or { addr, pending } while it's being looked up.
let solDest = null;
let bal = null; // { usdc, usdt, sol, usdcAccount }: base units, lamports, whether the USDC account exists
let busy = false; // a transfer started from the form is in progress
let evm = null; // Base wallet { address, wallet, ensureBase, name }: needed for EURC (it signs the swap)
let baseBal = null; // { usdc, eurc, eth, gasPrice } of the Base wallet
let topUpTouched = false; // the user ticked/unticked the top-up; otherwise it follows the Base gas balance
let preferredOut = 'USDC'; // the user's choice; EURC is re-selected once a Base wallet makes it available
let topUpEth = null; // ETH that B.TOPUP_USDC buys right now, for the label
let pendingSwap = null; // { amountIn, to, topUp, sent, sentAmount, before, fee } for the EURC swap
let pendingUsdt = null; // { amountIn, owner, sent, before, fee } for the USDC → USDT swap on Solana (Base → Solana)
let preferredOutS = 'USDC'; // Base → Solana: the user's choice; USDT is re-selected once a Solana wallet makes it available
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
const errMsg = (e) => e?.shortMessage || e?.message || String(e);
const currentDir = () => document.querySelector('input[name=dir]:checked').value;
const currentSrcB = () => document.querySelector('input[name=srcB]:checked').value; // Base → Solana: USDC or EURC
const currentOutS = () => document.querySelector('input[name=outS]:checked').value; // Base → Solana: USDC or USDT
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

// The Solana wallet entered, else the connected Solana wallet (Base → Solana).
function solRecipient() {
  const v = $('recipientSol').value.trim();
  if (!v) return owner;
  try {
    const pk = new S.PublicKey(v);
    return pk.toBase58() === v ? pk : null;
  } catch { return null; }
}

// Fees for the selected route (Base → Solana: with account creation when the recipient needs it).
function feesFor(all = allFees, dest = solDest) {
  if (!all) return null;
  if (currentDir() === 'toBase') return all.toBase;
  return dest?.needsAccount ? all.toSolSetup : all.toSol;
}

// Look up whether a Solana recipient has a USDC account, and that it isn't itself a token account.
async function lookupSolDest(pk) {
  const { value: [acct, usdcAcct] } = await rpc('getMultipleAccounts', [[pk.toBase58(), S.ata(pk, S.USDC_MINT).toBase58()], { encoding: 'base64', commitment: 'confirmed' }]);
  return { addr: pk.toBase58(), needsAccount: !usdcAcct, tokenAccount: acct?.owner === S.TOKEN_PROGRAM_ID.toBase58() };
}
function checkSolDest(pk) {
  if (solDest?.addr === pk.toBase58()) return;
  solDest = { addr: pk.toBase58(), pending: true };
  lookupSolDest(pk).then((d) => { if (solDest?.addr === d.addr) { solDest = d; refreshForm(); } })
    .catch((e) => { console.warn('recipient lookup', e); if (solDest?.addr === pk.toBase58()) solDest = null; });
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
function resetSteps(dir = currentDir()) {
  for (const li of document.querySelectorAll('#steps li')) {
    li.className = '';
    li.hidden = false;
    li.querySelector('.elapsed')?.remove();
  }
  const toSol = dir === 'toSol';
  const step = (name) => document.querySelector(`#steps li[data-step="${name}"]`);
  step('swapIn').textContent = toSol ? 'Swap EURC to USDC on Aerodrome' : 'Swap USDT to USDC';
  step('burn').textContent = `Burn USDC on ${toSol ? 'Base' : 'Solana'}`;
  step('mint').textContent = `Circle mints on ${toSol ? 'Solana' : 'Base'}`;
  step('swap').textContent = toSol ? 'Swap USDC to USDT on Jupiter' : 'Swap USDC to EURC on Aerodrome';
  step('swapIn').hidden = toSol ? currentSrcB() !== 'EURC' : currentSrc() !== 'USDT';
  step('swap').hidden = toSol ? currentOutS() !== 'USDT' : currentOut() !== 'EURC';
  $('retrySwap').hidden = true;
  pendingSwap = null;
  pendingUsdt = null;
  $('progress').hidden = false;
}

// ---------- fees and quotes ----------

async function loadFees() {
  try {
    const route = async (from, to, extra = '') => {
      const list = await (await fetch(`${IRIS}/v2/burn/USDC/fees/${from}/${to}?forward=true${extra}`)).json();
      const pick = (threshold) => {
        const f = list.find((x) => x.finalityThreshold === threshold);
        if (!f?.forwardFee) throw new Error('missing forward fee');
        return { bps: f.minimumFee, forward: BigInt(f.forwardFee.high) };
      };
      return { fast: pick(FINALITY.fast), standard: pick(FINALITY.standard) };
    };
    const [toBase, toSol, toSolSetup] = await Promise.all([
      route(S.DOMAIN_SOLANA, S.DOMAIN_BASE),
      route(S.DOMAIN_BASE, S.DOMAIN_SOLANA),
      route(S.DOMAIN_BASE, S.DOMAIN_SOLANA, '&includeRecipientSetup=true'),
    ]);
    allFees = { toBase, toSol, toSolSetup };
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
function maxFeeFor(amount, mode, f = feesFor()) {
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

  const dir = currentDir();
  for (const el of document.querySelectorAll('[data-dir]')) el.hidden = el.dataset.dir !== dir;
  $('recipientLabel').htmlFor = dir === 'toSol' ? 'recipientSol' : 'recipient';
  if (!evm) $('evmAccount').textContent = `Base wallet: not connected (needed ${dir === 'toSol' ? 'to send from Base' : 'for EURC'})`;
  $('stdTime').textContent = dir === 'toSol' ? 'about 15–20 minutes on Base' : 'about half a minute on Solana';
  if (dir === 'toSol') { refreshFormToSol(); return; }

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
    const fee = allFees ? maxFeeFor(usdc ?? 0n, mode) : null;
    $(mode === 'fast' ? 'feeFast' : 'feeStd').textContent = fee === null ? ''
      : `· fee ≤ ${fmt(fee + (src === 'USDT' ? USDT_FEE_TOLERANCE : 0n))} USDC`;
  }

  let label = 'Bridge to Base';
  let ok = !!owner && !!amt && !!allFees && !!recipient();
  let receive = '';
  if (!allFees) {
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

// Quotes for Base → Solana, by kind and input amount: { value } or { error }, refreshed after 30 s.
// A request waits 400 ms (typing), and only the latest one per kind is fetched.
const quoteCache = new Map();
const quoteWanted = {};
function quoteFor(kind, amount, fetcher) {
  const key = `${kind}:${amount}`;
  const q = quoteCache.get(key);
  if ((!q || Date.now() - q.at > 30_000) && quoteWanted[kind] !== key) {
    quoteWanted[kind] = key;
    setTimeout(async () => {
      if (quoteWanted[kind] !== key) return;
      try {
        quoteCache.set(key, { value: await fetcher(), at: Date.now() });
      } catch (e) {
        const old = quoteCache.get(key);
        if (old?.value) old.at = Date.now(); // keep showing it; retry later
        else quoteCache.set(key, { error: true, at: Date.now() });
      }
      if (quoteWanted[kind] === key) quoteWanted[kind] = null;
      refreshForm();
    }, 400);
  }
  return q;
}
const eurcInQuote = (amount) => quoteFor('eurcIn', amount, () => B.quoteUsdcFromEurc(amount));
let shownUsdt = null; // { key, text }: the last USDT quote shown, per input (see refreshFormToSol)
const usdtOutQuote = (amount) => quoteFor('usdtOut', amount, () => S.jupiterQuote(amount, SLIPPAGE_BPS, S.USDC_MINT, S.USDT_MINT));

// SOL the Solana wallet needs to swap the minted USDC to USDT: fees, plus a USDT account if missing.
const solForUsdt = () => LAMPORTS.fees + LAMPORTS.swap + (bal?.usdtAccount ? 0n : LAMPORTS.usdcAccount);

// The form for Base → Solana: USDC (or EURC, swapped first) from the connected Base wallet to a Solana
// wallet, received as USDC (or USDT, swapped by the connected Solana wallet).
function refreshFormToSol() {
  const srcB = currentSrcB();
  // USDT needs the connected Solana wallet: the USDC is minted to it, and it signs the swap.
  const usdtRadio = document.querySelector('input[name=outS][value=USDT]');
  usdtRadio.disabled = !owner;
  if (owner && preferredOutS === 'USDT') usdtRadio.checked = true;
  if (!owner && usdtRadio.checked) document.querySelector('input[name=outS][value=USDC]').checked = true;
  const out = currentOutS();
  $('usdtHint').textContent = owner ? '· your Solana wallet receives it and signs the swap; needs a little SOL' : '· needs a connected Solana wallet with a little SOL';
  const toOwner = out === 'USDT';
  $('recipientSol').hidden = toOwner;

  const typed = toOwner ? '' : $('recipientSol').value.trim();
  const dest = toOwner ? owner : solRecipient();
  if (dest) checkSolDest(dest);
  const d = dest && solDest?.addr === dest.toBase58() && !solDest.pending ? solDest : null;
  $('recipientLabel').textContent = toOwner ? 'USDT recipient on Solana' : 'Recipient on Solana';
  $('recipientSol').placeholder = owner ? `defaults to your Solana wallet ${short(owner.toBase58())}` : 'your Solana wallet address';
  const name = wallet?.name ?? 'wallet';
  const who = !dest ? ''
    : toOwner ? `Your connected Solana wallet (${name}, ${short(dest.toBase58())}): the USDC is minted to it, and it signs the swap.`
      : !typed ? `Using your connected Solana wallet (${name}).`
        : owner && dest.equals(owner) ? `This is your connected Solana wallet (${name}).`
          : 'Make sure you control this address on Solana.';
  const setupFee = allFees ? allFees.toSolSetup[currentMode()].forward - allFees.toSol[currentMode()].forward : 0n;
  const account = !d ? ''
    : d.tokenAccount ? ' This is a token account, not a wallet: enter the wallet address.'
      : d.needsAccount ? ` It has no USDC account yet: Circle creates one, which adds about ${fmt(setupFee)} USDC to the fee.${toOwner ? '' : ' No SOL needed.'}` : '';
  $('recipientHint').textContent = who + account;
  $('amountLabel').textContent = `Amount (${srcB})`;

  const amt = parseAmount();
  let usdc = amt;
  let eurcNote = '';
  let eq = null;
  if (srcB === 'EURC' && amt) {
    eq = eurcInQuote(amt);
    usdc = eq?.value ? eq.value.amountOut : null;
    if (usdc) eurcNote = `${fmt(amt)} EURC → about ${fmt(usdc)} USDC via Aerodrome`;
  }
  const tolerance = srcB === 'EURC' ? USDT_FEE_TOLERANCE : 0n;
  for (const mode of ['fast', 'standard']) {
    $(mode === 'fast' ? 'feeFast' : 'feeStd').textContent = allFees ? `· fee ≤ ${fmt(maxFeeFor(usdc ?? 0n, mode, feesFor(allFees, d)) + tolerance)} USDC` : '';
  }

  let label = 'Bridge to Solana';
  let ok = false;
  let receive = '';
  let warn = '';
  const gas = baseBal ? (B.GAS_UNITS.burn + (srcB === 'EURC' ? B.GAS_UNITS.swap : 0n)) * baseBal.gasPrice : 0n;
  if (!allFees) label = 'Loading fees…';
  else if (!evm) label = 'Connect a Base wallet';
  else if (!amt) label = 'Enter an amount';
  else if (!usdc) label = eq?.error ? 'No EURC → USDC route right now' : 'Getting EURC → USDC quote…';
  else if (!dest) label = typed ? 'Recipient is not a valid Solana address' : 'Enter the Solana recipient';
  else if (!d) label = 'Checking the recipient on Solana…';
  else if (d.tokenAccount) label = 'Enter a wallet address, not a token account';
  else {
    const fee = maxFeeFor(usdc, currentMode(), feesFor(allFees, d));
    const minted = usdc - fee;
    if (minted <= 0n) label = 'Amount must be larger than the fee';
    else if (baseBal && amt > (srcB === 'EURC' ? baseBal.eurc : baseBal.usdc)) label = `Insufficient ${srcB} on Base`;
    else if (baseBal && baseBal.eth < gas) {
      label = 'Not enough ETH on Base';
      warn = `This needs about ${fmtEth(gas)} ETH on Base for gas; you have ${fmtEth(baseBal.eth)}.`;
    } else if (toOwner && bal && bal.sol < solForUsdt()) {
      label = 'Not enough SOL for the USDT swap';
      warn = `The USDT swap needs about ${fmtSol(solForUsdt())} SOL in your Solana wallet (network fees${bal.usdtAccount ? '' : ' and a USDT account'}); you have ${fmtSol(bal.sol)}.`;
    } else ok = !!baseBal && (!toOwner || !!bal);
    const created = d.needsAccount ? ', in a USDC account Circle creates for the recipient' : '';
    if (minted > 0n && toOwner) {
      // The minted amount moves a little whenever the fee or the EURC quote refreshes; until the USDT
      // quote for the new amount arrives, keep showing the last one for the same input.
      const inputKey = `${srcB}:${amt}:${currentMode()}:${d.needsAccount}`;
      const uq = usdtOutQuote(minted);
      if (uq?.value) {
        receive = `You receive about ${fmt(BigInt(uq.value.outAmount))} USDT on Solana (${eurcNote ? `${eurcNote}, then ` : ''}Circle's fee, then ${fmt(minted)} USDC → USDT via Jupiter, max 0.5% slippage)`;
        shownUsdt = { key: inputKey, text: receive };
      } else if (shownUsdt?.key === inputKey) {
        receive = shownUsdt.text;
      } else {
        receive = uq?.error ? 'No USDC → USDT route on Jupiter right now.' : 'Getting USDC → USDT quote…';
        if (uq?.error) ok = false;
      }
    } else if (minted > 0n) {
      receive = eurcNote ? `You receive about ${fmt(minted)} USDC on Solana${created} (${eurcNote}, then Circle's fee)` : `You receive at least ${fmt(minted)} USDC on Solana${created}`;
    }
  }
  if (receive !== $('receive').textContent) $('receive').textContent = receive;
  shownQuoteKey = null;
  if (warn !== $('solWarn').textContent) $('solWarn').textContent = warn;
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
    disconnect: () => w.features['standard:disconnect']?.disconnect(),
  };
  setOwner(new S.PublicKey(account.address));
  const off = w.features['standard:events']?.on('change', ({ accounts }) => {
    if (accounts) setOwner(accounts[0] ? new S.PublicKey(accounts[0].address) : null);
  });
  const disconnect = wallet.disconnect;
  wallet.disconnect = async () => { off?.(); await disconnect(); };
}

const onAccount = (pk) => setOwner(pk ? new S.PublicKey(pk.toString()) : null);
const onDisconnect = () => setOwner(null);
async function connectInjected(p, silent) {
  const res = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
  const pk = res?.publicKey ?? p.publicKey;
  wallet = {
    name: p.isPhantom ? 'Phantom' : p.isSolflare ? 'Solflare' : 'wallet',
    signTransaction: async (tx) => S.VersionedTransaction.deserialize((await p.signTransaction(tx)).serialize()),
    disconnect: async () => { p.off?.('accountChanged', onAccount); p.off?.('disconnect', onDisconnect); await p.disconnect?.(); },
  };
  setOwner(pk ? new S.PublicKey(pk.toString()) : null);
  p.on?.('accountChanged', onAccount);
  p.on?.('disconnect', onDisconnect);
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
    wc: true,
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
    disconnect: () => disconnectWalletConnect(client, session.topic),
  };
  setOwner(pk);
  const baseAccount = session.namespaces.eip155?.accounts.find((a) => a.startsWith('eip155:8453:'));
  if (baseAccount) {
    setEvm({
      ...B.walletConnectBaseWallet(client, session.topic, baseAccount.split(':')[2]), name: session.peer.metadata.name,
      disconnect: () => disconnectWalletConnect(client, session.topic),
    });
  }
}

// Ends the WalletConnect session, which covers both chains.
async function disconnectWalletConnect(client, topic) {
  try { localStorage.removeItem(WC_KEY); } catch {}
  try {
    await client.disconnect({ topic, reason: { code: 6000, message: 'User disconnected' } });
  } catch (e) {
    console.warn('walletconnect disconnect', e);
  }
  if (wallet?.wc) { wallet = null; setOwner(null); }
  if (evm) setEvm(null);
}

async function disconnectSolana() {
  if (busy || !wallet) return;
  try { localStorage.setItem(SOL_OFF_KEY, '1'); } catch {}
  const w = wallet;
  wallet = null;
  setOwner(null);
  try { await w.disconnect?.(); } catch (e) { console.warn('disconnect', e); }
}

async function disconnectBase() {
  if (busy || !evm) return;
  const e = evm;
  try { localStorage.removeItem(BASE_WALLET_KEY); } catch {}
  setEvm(null);
  if (e.disconnect) return e.disconnect();
  // Extension wallets: ask them to forget this site where supported (MetaMask, Rabby); otherwise it only
  // stops using the wallet here.
  try { await window.ethereum?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch {}
}

async function connect(silent = false) {
  if (silent) { try { if (localStorage.getItem(SOL_OFF_KEY)) return; } catch {} }
  else { try { localStorage.removeItem(SOL_OFF_KEY); } catch {} }
  if (standardWallets.length) return connectStandard(standardWallets[0], silent);
  const p = findInjected();
  if (p) return connectInjected(p, silent);
  if (!silent) $('noWallet').hidden = false;
}

function setOwner(pk) {
  owner = pk;
  $('account').textContent = owner ? `Connected${wallet?.name ? ` (${wallet.name})` : ''}: ${short(owner.toBase58())}` : 'Not connected';
  $('connect').textContent = owner ? 'Disconnect' : 'Connect Solana wallet';
  $('connect').classList.toggle('ghost', !!owner);
  $('connect').title = owner && wallet?.wc ? 'Ends the WalletConnect session (Solana and Base)' : '';
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
    bal = { usdc: tokenAmount(accts[0]) ?? 0n, usdt: tokenAmount(accts[1]) ?? 0n, sol: BigInt(sol), usdcAccount: !!accts[0], usdtAccount: !!accts[1] };
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
  if (!window.ethereum) { $('noBaseWallet').hidden = false; return; }
  const w = await B.injectedBaseWallet(window.ethereum);
  setEvm({ ...w, name: window.ethereum.isRabby ? 'Rabby' : window.ethereum.isPhantom ? 'Phantom' : window.ethereum.isMetaMask ? 'MetaMask' : 'your Base wallet' });
  try { localStorage.setItem(BASE_WALLET_KEY, 'injected'); } catch {}
  if (!baseListening) {
    baseListening = true;
    // Follow account switches in the extension, unless the user disconnected it here.
    window.ethereum.on?.('accountsChanged', (accs) => {
      if (!evm || evm.disconnect) return;
      if (accs[0]) connectBase(); else setEvm(null);
    });
  }
}
let baseListening = false;

function setEvm(e) {
  evm = e;
  $('evmAccount').textContent = evm ? `Base wallet (${evm.name}): ${short(evm.address)}` : 'Base wallet: not connected (needed for EURC)';
  $('connectBase').hidden = !!evm;
  $('disconnectBase').hidden = !evm;
  $('disconnectBase').title = evm?.disconnect ? 'Ends the WalletConnect session (Solana and Base)' : '';
  if (evm) $('noBaseWallet').hidden = true;
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

// Swap with Jupiter from the connected Solana wallet, after checking the swap by simulation.
// Resolves to the amount of outMint received. Only for USDT ↔ USDC (checked against 1:1).
async function jupiterSwap(inMint, outMint, amountIn, [inName, outName]) {
  setStatus('Getting a Jupiter route…');
  const quote = await S.jupiterQuote(amountIn, SLIPPAGE_BPS, inMint, outMint);
  const minOut = BigInt(quote.otherAmountThreshold);
  // Sanity floor independent of Jupiter: USDT and USDC trade near 1:1.
  if (minOut < (amountIn * 98n) / 100n) throw new Error('Jupiter quote is too far from 1:1');
  const { tx, lastValidBlockHeight } = await S.jupiterSwapTx(quote, owner);
  await S.checkSwapBySimulation(rpc, tx, owner, amountIn, minOut, inMint, outMint);
  const outNow = async () => tokenAmount((await rpc('getMultipleAccounts', [[S.ata(owner, outMint).toBase58()], { encoding: 'base64', commitment: 'confirmed' }])).value[0]) ?? 0n;
  const before = await outNow();
  setStatus(`Confirm the swap of ${fmt(amountIn)} ${inName} for about ${fmt(BigInt(quote.outAmount))} ${outName} ${inWallet()}…`);
  if (wallet.signAndSend) await sendWatched(tx, lastValidBlockHeight, 'Swap', async () => (await outNow()) >= before + minOut);
  else await signAndSend(tx, lastValidBlockHeight, 'Swap');
  const received = (await outNow()) - before;
  if (received <= 0n) throw new Error(`The swap delivered no ${outName}`);
  return received;
}

// Swap USDT → USDC (Solana → Base, paying with USDT). Resolves to the USDC received.
async function swapUsdtToUsdc(amountIn) {
  setStep('swapIn', 'active');
  const received = await jupiterSwap(S.USDT_MINT, S.USDC_MINT, amountIn, ['USDT', 'USDC']);
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
  if (!amount || !allFees || !to || !owner) return;
  const src = currentSrc();
  const shownUsdc = src === 'USDT' ? (usdtQuote?.key === amount && !usdtQuote.error ? BigInt(usdtQuote.quote.outAmount) : null) : amount;
  if (!shownUsdc) return;
  await askNotifications();
  const mode = currentMode();
  try { if ($('recipient').value.trim()) localStorage.setItem(RECIPIENT_KEY, recipient()); } catch {}

  $('bridge').disabled = true;
  resetSteps();
  busy = true;
  const shownFees = allFees.toBase;
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
    const maxFee = maxFeeFor(amount, mode, allFees.toBase);
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

// Base → Solana: optionally swap EURC → USDC on Aerodrome, burn on Base with the forwarding hook, and
// Circle mints on Solana (creating the recipient's USDC account first if needed, paid from its fee);
// optionally the Solana wallet then swaps the USDC to USDT.
async function bridgeToSolana() {
  let amount = parseAmount();
  const srcB = currentSrcB();
  const out = currentOutS();
  const dest = out === 'USDT' ? owner : solRecipient();
  if (!amount || !allFees || !dest || !evm) return;
  const shownUsdc = srcB === 'EURC' ? quoteCache.get(`eurcIn:${amount}`)?.value?.amountOut : amount;
  if (!shownUsdc) return;
  await askNotifications();
  const mode = currentMode();
  try { if (out !== 'USDT' && $('recipientSol').value.trim()) localStorage.setItem(RECIPIENT_SOL_KEY, dest.toBase58()); } catch {}
  // Never charge more than the fee the user saw (plus a little when the amount comes from a swap).
  const shownFee = maxFeeFor(shownUsdc, mode, feesFor(allFees, solDest)) + (srcB === 'EURC' ? USDT_FEE_TOLERANCE : 0n);

  $('bridge').disabled = true;
  resetSteps('toSol');
  busy = true;
  let source = null; // { amount } when paid with EURC
  let unburned = null; // USDC from the EURC swap that hasn't been burned yet
  try {
    if (srcB === 'EURC') {
      setStep('swapIn', 'active');
      const r = await B.swapEurcToUsdc({ signer: evm, amountIn: amount, setStatus, inWallet: inBaseWallet });
      source = { amount, hash: r.hash };
      amount = r.usdcOut;
      unburned = amount;
      setStep('swapIn', 'done');
      refreshBaseBalances();
    }

    setStep('burn', 'active');
    setStatus('Checking the recipient and the current fee…');
    // The account may have been created (or closed) since the form looked; decide on what's there now.
    const [d] = await Promise.all([lookupSolDest(dest), loadFees().then((ok) => { if (!ok) throw new Error('Could not load current fees from Circle. Try again.'); })]);
    if (d.tokenAccount) throw new Error('The recipient is a token account, not a wallet. Enter the wallet address.');
    const maxFee = maxFeeFor(amount, mode, feesFor(allFees, d));
    const swapped = source ? `Swapped to ${fmt(amount)} USDC. ` : '';
    if (maxFee > shownFee) throw new Error(`${swapped}Circle's fee just went up from ${fmt(shownFee)} to ${fmt(maxFee)} USDC. Click Bridge again to accept it.`);
    if (amount <= maxFee) throw new Error(`${swapped}Amount must be larger than the fee.`);

    const hash = await B.burnUsdc({
      signer: evm, amount, destinationDomain: S.DOMAIN_SOLANA, mintRecipient: S.usdcMintRecipient(dest),
      maxFee, minFinalityThreshold: FINALITY[mode], hookData: S.solanaForwardHook(dest, d.needsAccount),
      setStatus, inWallet: inBaseWallet,
    });
    unburned = null;
    savePending({ sig: hash, dir: 'toSol', to: dest.toBase58(), out });
    setStep('burn', 'done');
    refreshBaseBalances();
    await finishToSol(await track(hash, mode, 'toSol'), dest.toBase58(), out, source);
  } catch (e) {
    console.error(e);
    setStatus(explain(e), 'err');
    // Stopped after the EURC swap but before the burn: set the form to bridge that USDC.
    if (unburned) {
      document.querySelector('input[name=srcB][value=USDC]').checked = true;
      $('amount').value = (Number(unburned) / 1e6).toFixed(6).replace(/\.?0+$/, '');
    }
  } finally {
    busy = false;
    refreshForm();
  }
}

async function finishToSol(m, to, out = 'USDC', source = null) {
  // A USDT transfer stays saved (for Resume after a reload) until its swap is done.
  if (out !== 'USDT') clearPending();
  refreshBalances();
  refreshBaseBalances();
  solDest = null; // the recipient now has a USDC account
  const link = solTx(m.forwardTxHash);
  const body = m.decodedMessage?.decodedMessageBody;
  if (!body?.amount) {
    setStatus(out === 'USDT' ? `USDC minted on Solana ${link}, but the transfer amount couldn't be read, so no swap was made.` : `Done! USDC minted on Solana ${link}.`, out === 'USDT' ? 'err' : 'ok');
    return;
  }
  const burned = BigInt(body.amount);
  const fee = BigInt(body.feeExecuted ?? body.maxFee ?? 0);
  const minted = burned - fee;
  const account = new S.PublicKey(Uint8Array.from(body.mintRecipient.replace(/^0x/, '').match(/../g), (h) => parseInt(h, 16))).toBase58();
  const forWhom = to ? `for ${short(to)}` : `in USDC account ${short(account)}`;
  const sent = source ? `${fmt(source.amount)} EURC` : `${fmt(burned)} USDC`;
  const before = source ? `EURC → ${fmt(burned)} USDC via Aerodrome ${baseTx(source.hash)}, ` : '';
  if (out !== 'USDT') {
    setStatus(`Done! ${sent} → ${fmt(minted)} USDC on Solana ${forWhom} ${link}. Fees: ${before}Circle's fee ${fmt(fee)} USDC.`, 'ok');
    return;
  }
  if (!to) {
    setStatus(`${fmt(minted)} USDC minted on Solana ${link}. Connect the Solana wallet it went to (USDC account ${short(account)}) and use Resume again with the burn transaction from the same browser to swap it to USDT.`, 'err');
    return;
  }
  // Swap only what this transfer delivered, never other USDC in the wallet.
  pendingUsdt = { amountIn: minted, owner: to, sent, before, fee };
  setStatus(`${fmt(minted)} USDC minted on Solana ${link}. Now swapping to USDT…`);
  await swapToUsdt();
}

// Swap the bridged USDC to USDT, signed by the Solana wallet it was minted to.
async function swapToUsdt() {
  const p = pendingUsdt;
  if (!p) return;
  $('retrySwap').hidden = true;
  setStep('swap', 'active');
  try {
    if (!owner || owner.toBase58() !== p.owner) throw new Error(`The USDC went to ${short(p.owner)}. Connect that Solana wallet to swap.`);
    const usdt = await jupiterSwap(S.USDC_MINT, S.USDT_MINT, p.amountIn, ['USDC', 'USDT']);
    setStep('swap', 'done');
    pendingUsdt = null;
    clearPending();
    setStatus(`Done! ${p.sent} → ${fmt(usdt)} USDT on Solana. Fees: ${p.before}Circle's fee ${fmt(p.fee)} USDC, then the Jupiter swap.`, 'ok');
    refreshBalances();
  } catch (e) {
    console.error(e);
    setStatus(`Swap failed: ${explain(e)} Your USDC is safe on Solana.`, 'err');
    $('retrySwap').textContent = 'Swap to USDT';
    $('retrySwap').hidden = false;
  }
}

async function resume() {
  const sig = $('resumeSig').value.trim();
  const saved = loadPending();
  const same = saved?.sig === sig;
  if (/^0x[0-9a-fA-F]{64}$/.test(sig)) {
    await askNotifications();
    const out = same ? saved.out ?? 'USDC' : 'USDC';
    resetSteps('toSol');
    document.querySelector('#steps li[data-step="swapIn"]').hidden = true;
    document.querySelector('#steps li[data-step="swap"]').hidden = out !== 'USDT';
    setStep('burn', 'done');
    try {
      await finishToSol(await track(sig, null, 'toSol'), same ? saved.to : null, out);
    } catch (e) {
      console.error(e);
      setStatus(errMsg(e), 'err');
    }
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) { $('resumeSig').setCustomValidity('Enter a Solana transaction signature or a Base transaction hash (0x…).'); $('resumeSig').reportValidity(); return; }
  await askNotifications();
  resetSteps('toBase');
  setStep('burn', 'done');
  try {
    await finish(await track(sig), null, same ? saved.out : currentOut(), same ? saved.eurcTo : recipient(), same ? saved.topUp : topUpOn());
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
  }
}

// Poll Circle until the forwarder has minted on the other chain. Resolves to the message.
async function track(sig, mode, dir = 'toBase') {
  const toSol = dir === 'toSol';
  const [srcDomain, dstDomain, dstName] = toSol ? [S.DOMAIN_BASE, S.DOMAIN_SOLANA, 'Solana'] : [S.DOMAIN_SOLANA, S.DOMAIN_BASE, 'Base'];
  setStep('attest', 'active');
  const wait = mode === 'fast' ? 'usually a few seconds' : mode === 'standard' ? (toSol ? 'usually 15–20 minutes, while Base finalizes' : 'usually under a minute') : 'this can take a while';
  setStatus(`Waiting for Circle to attest the burn (${wait}). You can close this page and resume later with ${toSol ? baseTx(sig) : solTx(sig)}.`);
  const url = `${IRIS}/v2/messages/${srcDomain}?transactionHash=${sig}`;
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
    if (m?.decodedMessage && Number(m.decodedMessage.destinationDomain) !== dstDomain) throw new Error(`This burn is not destined for ${dstName}.`);
    if (m?.forwardTxHash) {
      for (const s of ['attest', 'mint']) setStep(s, 'done');
      return m;
    }
    if (!attested && m?.status === 'complete') {
      attested = true;
      setStep('attest', 'done');
      setStep('mint', 'active');
      setStatus(`Attested. Waiting for Circle to mint on ${dstName}…`);
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
    $('retrySwap').textContent = 'Swap to EURC';
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
      dir: v('dir'), src: v('src'), srcB: v('srcB'), outS: preferredOutS, amount: $('amount').value, out: preferredOut, mode: v('mode'), topUp: topUpTouched ? $('topUp').checked : null,
    }));
  } catch {}
}
function loadForm() {
  try {
    const f = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null');
    if (!f) return;
    const pick = (name, value) => { const el = document.querySelector(`input[name=${name}][value="${value}"]`); if (el) el.checked = true; };
    pick('dir', f.dir);
    pick('src', f.src);
    pick('srcB', f.srcB);
    if (f.outS === 'USDT') preferredOutS = 'USDT';
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
      if (p.dir === 'toSol') document.querySelector('input[name=dir][value=toSol]').checked = true;
      if (p.out === 'USDT') preferredOutS = 'USDT';
    }
    const to = localStorage.getItem(RECIPIENT_KEY);
    if (to) $('recipient').value = to;
    const toSol = localStorage.getItem(RECIPIENT_SOL_KEY);
    if (toSol) $('recipientSol').value = toSol;
  } catch {}
}

// ---------- wire up ----------

$('connect').onclick = () => (owner ? disconnectSolana() : connect().catch((e) => alert(errMsg(e))));
$('disconnectBase').onclick = disconnectBase;
$('connectQr').onclick = () => connectWalletConnect().catch((e) => alert(errMsg(e)));
$('connectBase').onclick = () => connectBase().catch((e) => alert(errMsg(e)));
$('retrySwap').onclick = () => (pendingUsdt ? swapToUsdt() : swapToEurc());
$('sweep').onclick = sweep;
$('reclaim').onclick = reclaim;
$('topUp').onchange = () => { topUpTouched = true; refreshForm(); saveForm(); };
$('bridge').onclick = () => (currentDir() === 'toSol' ? bridgeToSolana() : bridge());
$('resume').onclick = resume;
$('amount').oninput = () => { refreshForm(); saveForm(); };
$('recipientSol').oninput = () => {
  refreshForm();
  const r = $('recipientSol').value.trim();
  try { if (!r) localStorage.removeItem(RECIPIENT_SOL_KEY); else if (solRecipient()) localStorage.setItem(RECIPIENT_SOL_KEY, r); } catch {}
};
$('resumeSig').oninput = () => $('resumeSig').setCustomValidity('');
$('recipient').oninput = () => {
  refreshForm();
  const r = $('recipient').value.trim();
  try { if (!r) localStorage.removeItem(RECIPIENT_KEY); else if (isAddress(r)) localStorage.setItem(RECIPIENT_KEY, getAddress(r)); } catch {}
};
$('max').onclick = () => {
  const max = currentDir() === 'toSol' ? baseBal && (currentSrcB() === 'EURC' ? baseBal.eurc : baseBal.usdc) : bal && (currentSrc() === 'USDT' ? bal.usdt : bal.usdc);
  if (max === undefined || max === null) return;
  $('amount').value = (Number(max) / 1e6).toString();
  refreshForm();
  saveForm();
};
for (const r of document.querySelectorAll('input[name=dir], input[name=mode], input[name=src], input[name=out], input[name=srcB], input[name=outS]')) {
  r.onchange = () => {
    if (r.name === 'out') preferredOut = r.value;
    if (r.name === 'outS') preferredOutS = r.value;
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
