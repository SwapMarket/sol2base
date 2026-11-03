import { isAddress, getAddress } from 'https://esm.sh/viem@2.21.55';
import * as S from 'solana';

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
// Public Solana RPCs that answer browser requests; the first one that works is used.
const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];

const $ = (id) => document.getElementById(id);
let wallet = null; // { name, signTransaction(VersionedTransaction) → VersionedTransaction }
let owner = null; // PublicKey
let fees = null; // { fast: { bps, forward }, standard: { bps, forward } }, forward in USDC base units
let bal = null; // { usdc, usdt, sol, usdcAccount }: base units, lamports, whether the USDC account exists
let busy = false; // a transfer started from the form is in progress

// ---------- helpers ----------

const fmt = (v) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtSol = (v) => (Number(v) / 1e9).toLocaleString(undefined, { maximumSignificantDigits: 4 });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const solTx = (s) => `<a href="https://solscan.io/tx/${s}" target="_blank" rel="noopener">${short(s)}</a>`;
const baseTx = (h) => `<a href="https://basescan.org/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const errMsg = (e) => e?.message || String(e);
const currentMode = () => document.querySelector('input[name=mode]:checked').value;
const currentSrc = () => document.querySelector('input[name=src]:checked').value;

function parseAmount() {
  const v = $('amount').value.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(v)) return null;
  const [i, d = ''] = v.split('.');
  const amt = BigInt(i) * 1_000_000n + BigInt(d.padEnd(6, '0'));
  return amt > 0n ? amt : null;
}

function recipient() {
  const v = $('recipient').value.trim();
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
    li.querySelector('.elapsed')?.remove();
  }
  document.querySelector('#steps li[data-step="swapIn"]').hidden = currentSrc() !== 'USDT';
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

// SOL this transfer needs, in lamports.
function solNeeded(src) {
  return LAMPORTS.eventRent + LAMPORTS.fees + (src === 'USDT' ? LAMPORTS.swap + (bal?.usdcAccount ? 0n : LAMPORTS.usdcAccount) : 0n);
}

function refreshForm() {
  if (busy) return; // keep the form as submitted while a transfer runs
  const src = currentSrc();
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
    if (usdc <= fee) {
      ok = false;
      label = 'Amount must be larger than the fee';
    } else {
      receive = usdtNote
        ? `You receive about ${fmt(usdc - fee)} USDC on Base (${usdtNote}, then Circle's fee)`
        : `You receive at least ${fmt(usdc - fee)} USDC on Base`;
    }
  }
  if (receive !== $('receive').textContent) $('receive').textContent = receive;

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
  $('balances').hidden = !owner;
  $('noWallet').hidden = true;
  refreshBalances();
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
  await signAndSend(tx, lastValidBlockHeight, 'Swap');
  const after = tokenAmount((await rpc('getMultipleAccounts', [[S.ata(owner, S.USDC_MINT).toBase58()], { encoding: 'base64', commitment: 'confirmed' }])).value[0]) ?? 0n;
  const received = after - before;
  if (received <= 0n) throw new Error('The swap delivered no USDC');
  setStep('swapIn', 'done');
  return received;
}

async function bridge() {
  let amount = parseAmount();
  const to = recipient();
  if (!amount || !fees || !to || !owner) return;
  const src = currentSrc();
  const shownUsdc = src === 'USDT' ? (usdtQuote?.key === amount && !usdtQuote.error ? BigInt(usdtQuote.quote.outAmount) : null) : amount;
  if (!shownUsdc) return;
  await askNotifications();
  const mode = currentMode();
  try { localStorage.setItem(RECIPIENT_KEY, to); } catch {}

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
    unburned = null;
    savePending(sig);
    setStep('burn', 'done');
    refreshBalances();

    await finish(await track(sig, mode), source);
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
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
  try {
    await finish(await track(sig));
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

function finish(m, source = null) {
  clearPending();
  refreshBalances();
  const body = m.decodedMessage?.decodedMessageBody;
  const link = baseTx(m.forwardTxHash);
  if (!body?.amount) {
    setStatus(`Done! USDC minted on Base ${link}.`, 'ok');
    return;
  }
  const burned = BigInt(body.amount);
  const fee = BigInt(body.feeExecuted ?? body.maxFee ?? 0);
  const to = `0x${body.mintRecipient.slice(-40)}`;
  const sent = source ? `${fmt(source.amount)} USDT` : `${fmt(burned)} USDC`;
  const before = source ? `USDT → ${fmt(burned)} USDC via Jupiter, ` : '';
  setStatus(`Done! ${sent} → ${fmt(burned - fee)} USDC on Base for ${short(getAddress(to))} ${link}. Fees: ${before}Circle's fee ${fmt(fee)} USDC. The ${fmtSol(LAMPORTS.eventRent)} SOL message-account rent can be reclaimed after 5 days.`, 'ok');
}

// ---------- persistence ----------

function savePending(sig) { try { localStorage.setItem(PENDING_KEY, sig); } catch {} }
function clearPending() { try { localStorage.removeItem(PENDING_KEY); } catch {} }
function loadSaved() {
  try {
    const sig = localStorage.getItem(PENDING_KEY);
    if (sig) {
      $('resumeSig').value = sig;
      $('resumeSig').closest('details').open = true;
    }
    const to = localStorage.getItem(RECIPIENT_KEY);
    if (to) $('recipient').value = to;
  } catch {}
}

// ---------- wire up ----------

$('connect').onclick = () => connect().catch((e) => alert(errMsg(e)));
$('bridge').onclick = bridge;
$('resume').onclick = resume;
$('amount').oninput = refreshForm;
$('recipient').oninput = refreshForm;
$('max').onclick = () => {
  if (!bal) return;
  $('amount').value = (Number(currentSrc() === 'USDT' ? bal.usdt : bal.usdc) / 1e6).toString();
  refreshForm();
};
for (const r of document.querySelectorAll('input[name=mode], input[name=src]')) r.onchange = refreshForm;
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
setInterval(() => { loadFees(); refreshBalances(); }, 30_000);
// Wallets that remember this site connect without a prompt (after standard wallets have registered).
setTimeout(() => connect(true).catch(() => {}), 300);
