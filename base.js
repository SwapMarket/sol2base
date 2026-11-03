// Base side of sol2base: swap the bridged USDC to EURC on Aerodrome Slipstream (optionally topping up
// ETH for gas in the same transaction), signed by the wallet the USDC was minted to.
// Ported from eth2base (github.com/SwapMarket/eth2base).
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  encodeFunctionData,
  getAddress,
} from 'https://esm.sh/viem@2.21.55';
import { base } from 'https://esm.sh/viem@2.21.55/chains';

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EURC_BASE = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
// Aerodrome Slipstream; USDC/EURC liquidity sits in tick spacings 1 and 50, USDC/WETH mostly in 100.
const AERO_ROUTER = '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5';
const AERO_QUOTER = '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';
const AERO_TICK_SPACINGS = [1, 50];
const AERO_WETH_TICK_SPACINGS = [100, 1, 2000];
export const TOPUP_USDC = 200_000n; // 0.20 USDC
const SLIPPAGE_BPS = 50n; // 0.5%
// Approve + swap ~280k gas; the top-up adds ~120k.
export const GAS_UNITS = { swap: 320_000n, topUp: 150_000n };
// Wallets price Base gas a little above the network (Rabby ~1.5x); used for warnings.
export const WALLET_MIN_GAS_PRICE = 15_000_000n; // 0.015 gwei

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const wethWithdrawalEvent = parseAbiItem('event Withdrawal(address indexed src, uint256 wad)');

export const baseClient = createPublicClient({
  chain: base,
  transport: fallback([http('https://mainnet.base.org'), http('https://base-rpc.publicnode.com')]),
});

const minOut = (amount) => (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const baseTx = (h) => `<a href="https://basescan.org/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;

// ---------- quotes and balances ----------

// Best USDC→token quote across Aerodrome Slipstream pools: { amountOut, tickSpacing }.
async function quoteAero(tokenOut, amountIn, tickSpacings) {
  const quotes = await Promise.allSettled(tickSpacings.map((tickSpacing) =>
    baseClient.simulateContract({
      address: AERO_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: USDC_BASE, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
    }).then(({ result }) => ({ amountOut: result[0], tickSpacing }))));
  const ok = quotes.filter((q) => q.status === 'fulfilled').map((q) => q.value);
  if (!ok.length) throw new Error('No Aerodrome quote');
  return ok.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
}
export const quoteEurc = (amountIn) => quoteAero(EURC_BASE, amountIn, AERO_TICK_SPACINGS);
export const quoteTopUp = () => quoteAero(WETH_BASE, TOPUP_USDC, AERO_WETH_TICK_SPACINGS);

// { usdc, eurc, eth, gasPrice } for a Base address.
export async function baseBalances(address) {
  const [usdc, eurc, eth, fees] = await Promise.all([
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    baseClient.readContract({ address: EURC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    baseClient.getBalance({ address }),
    baseClient.estimateFeesPerGas(),
  ]);
  return { usdc, eurc, eth, gasPrice: fees.maxFeePerGas };
}

// ---------- wallets ----------

// A viem wallet client for Base from an EIP-1193 provider (Rabby, MetaMask, Phantom's EVM side…).
export async function injectedBaseWallet(eip1193) {
  const wallet = createWalletClient({ chain: base, transport: custom(eip1193) });
  const [address] = await wallet.requestAddresses();
  return { address: getAddress(address), wallet, ensureBase: () => ensureBase(wallet) };
}

// A viem wallet client that signs over a WalletConnect session (Base account in the eip155 namespace);
// reads go to public Base RPCs.
export function walletConnectBaseWallet(client, topic, address) {
  const chainId = `eip155:${base.id}`;
  const wallet = createWalletClient({
    chain: base,
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_chainId') return `0x${base.id.toString(16)}`;
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
        if (method === 'eth_sendTransaction') return client.request({ topic, chainId, request: { method, params } });
        return baseClient.request({ method, params });
      },
    }),
  });
  return { address: getAddress(address), wallet, ensureBase: async () => {} };
}

async function ensureBase(wallet) {
  if ((await wallet.getChainId()) === base.id) return;
  try {
    await wallet.switchChain({ id: base.id });
  } catch (e) {
    if (e?.code === 4902 || e?.cause?.code === 4902) await wallet.addChain({ chain: base });
    else throw e;
  }
}

// Send a transaction and wait for it to be mined. Over WalletConnect the wallet's reply (the tx hash)
// can get lost even though the transaction went out, so also watch the chain for its effect and carry
// on as soon as either shows up. check() returns the mined tx hash, true (effect seen, hash unknown),
// or nothing yet. Resolves to the receipt, or null when only the effect was seen.
async function sendWatched({ account, send, check, label, setStatus }) {
  let watching = true;
  const baseNonce = baseClient.getTransactionCount({ address: account, blockTag: 'pending' }).catch(() => null);
  let submitted = false;
  const sent = send();
  sent.catch(() => {}); // a rejection still reaches the race below
  const seen = (async () => {
    while (watching) {
      await sleep(3000);
      try {
        const r = await check();
        if (r) return r;
        const before = await baseNonce;
        if (!submitted && watching && before !== null
          && (await baseClient.getTransactionCount({ address: account, blockTag: 'pending' })) > before) {
          submitted = true;
          if (watching) setStatus(`${label} submitted, waiting for it to be mined on Base…`);
        }
      } catch (e) {
        console.warn('chain watch failed', e);
      }
    }
    return new Promise(() => {});
  })();
  let hash;
  try {
    hash = await Promise.race([sent, seen.then((r) => (r === true ? null : r))]);
  } finally {
    watching = false;
  }
  if (!hash) return null;
  setStatus(`${label} sent ${baseTx(hash)}, waiting for confirmation…`);
  const receipt = await baseClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} transaction reverted`);
  return receipt;
}

// ---------- swap ----------

// Swap `amountIn` USDC (capped at the signer's balance) to EURC for `to`, with the optional gas top-up
// unwrapped to the signer. Resolves to { amountIn, eurcOut, ethOut, topUp, hash }.
export async function swapToEurc({ signer, amountIn: wanted, to, topUp: withTopUp, setStatus, inWallet }) {
  const { address: account, wallet } = signer;
  const balance = await baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  const amountIn = balance < wanted ? balance : wanted;
  if (amountIn === 0n) throw new Error('No USDC on Base to swap.');
  if ((await baseClient.getBalance({ address: account })) === 0n) {
    throw new Error('You need a little ETH on Base to pay gas for the swap. Your USDC is already on Base; add some ETH and retry.');
  }
  await signer.ensureBase();

  const allowance = await baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account, AERO_ROUTER] });
  if (allowance < amountIn) {
    setStatus(`Confirm the USDC approval for Aerodrome ${inWallet()}…`);
    await sendWatched({
      account, label: 'Approval', setStatus,
      send: () => wallet.writeContract({ account, address: USDC_BASE, abi: erc20Abi, functionName: 'approve', args: [AERO_ROUTER, amountIn] }),
      check: async () => (await baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account, AERO_ROUTER] })) >= amountIn,
    });
  }

  // With the top-up, part of the USDC is swapped to WETH (kept in the router) and unwrapped to the
  // signer as ETH, all in one multicall with the EURC swap.
  const topUp = withTopUp && amountIn > 2n * TOPUP_USDC ? TOPUP_USDC : 0n;
  const [{ amountOut, tickSpacing }, eth] = await Promise.all([quoteEurc(amountIn - topUp), topUp ? quoteTopUp() : null]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const eurcSwap = {
    tokenIn: USDC_BASE, tokenOut: EURC_BASE, tickSpacing, recipient: to,
    deadline, amountIn: amountIn - topUp, amountOutMinimum: minOut(amountOut), sqrtPriceLimitX96: 0n,
  };
  setStatus(`Confirm the swap of ${Number(amountIn) / 1e6} USDC for about ${Number(amountOut) / 1e6} EURC${eth ? ' plus ETH for gas' : ''} ${inWallet()}…`);
  const fromBlock = await baseClient.getBlockNumber();
  const r = await sendWatched({
    account, label: 'Swap', setStatus,
    send: () => (eth
      ? wallet.writeContract({
        account, address: AERO_ROUTER, abi: routerAbi, functionName: 'multicall',
        args: [[
          encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [eurcSwap] }),
          encodeFunctionData({
            abi: routerAbi, functionName: 'exactInputSingle',
            args: [{ tokenIn: USDC_BASE, tokenOut: WETH_BASE, tickSpacing: eth.tickSpacing, recipient: AERO_ROUTER, deadline, amountIn: topUp, amountOutMinimum: minOut(eth.amountOut), sqrtPriceLimitX96: 0n }],
          }),
          encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [minOut(eth.amountOut), account] }),
        ]],
      })
      : wallet.writeContract({ account, address: AERO_ROUTER, abi: routerAbi, functionName: 'exactInputSingle', args: [eurcSwap] })),
    check: async () => (await baseClient.getLogs({ address: EURC_BASE, event: transferEvent, args: { to }, fromBlock })).at(-1)?.transactionHash,
  });
  const eurcOut = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })
    .filter((l) => l.address.toLowerCase() === EURC_BASE.toLowerCase() && l.args.to === to)
    .reduce((sum, l) => sum + l.args.value, 0n);
  const ethOut = parseEventLogs({ abi: [wethWithdrawalEvent], logs: r.logs })
    .filter((l) => l.address.toLowerCase() === WETH_BASE.toLowerCase())
    .reduce((sum, l) => sum + l.args.wad, 0n);
  return { amountIn, eurcOut, ethOut, topUp, hash: r.transactionHash };
}
