// Solana side of sol2base: Circle CCTP V2 burn (with Circle's forwarding hook) and Jupiter USDT → USDC swaps.
// Instruction layouts follow Circle's published IDL for TokenMessengerMinterV2
// (github.com/circlefin/solana-cctp-contracts, examples/target/idl/token_messenger_minter_v2.json).
import {
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from 'https://esm.sh/@solana/web3.js@1.95.8';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MESSAGE_TRANSMITTER = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC');
const TOKEN_MESSENGER_MINTER = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe');
export const DOMAIN_SOLANA = 5;
export const DOMAIN_BASE = 6;
// Circle Forwarding Service hook: "cctp-forward", version 0, no extra data.
const FORWARD_HOOK = Uint8Array.from('636374702d666f72776172640000000000000000000000000000000000000000'.match(/../g), (h) => parseInt(h, 16));
// sha256("global:deposit_for_burn_with_hook")[0..8], from the IDL.
const DEPOSIT_FOR_BURN_WITH_HOOK = [111, 245, 62, 131, 204, 108, 223, 155];

const utf8 = (s) => new TextEncoder().encode(s);
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? utf8(s) : s.toBytes())), program)[0];

// Accounts CCTP initialised at fixed PDAs (checked against mainnet: the Base remote token messenger
// is domain 6 and points at TokenMessengerV2 0x28b5…cf5d on Base).
const MESSAGE_TRANSMITTER_STATE = pda(['message_transmitter'], MESSAGE_TRANSMITTER);
const TOKEN_MESSENGER = pda(['token_messenger'], TOKEN_MESSENGER_MINTER);
const TOKEN_MINTER = pda(['token_minter'], TOKEN_MESSENGER_MINTER);
const REMOTE_TOKEN_MESSENGER_BASE = pda(['remote_token_messenger', String(DOMAIN_BASE)], TOKEN_MESSENGER_MINTER);
const LOCAL_TOKEN_USDC = pda(['local_token', USDC_MINT], TOKEN_MESSENGER_MINTER);
const SENDER_AUTHORITY = pda(['sender_authority'], TOKEN_MESSENGER_MINTER);
const EVENT_AUTHORITY = pda(['__event_authority'], TOKEN_MESSENGER_MINTER);

export const ata = (owner, mint) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];

// 20-byte EVM address → 32-byte CCTP recipient.
function evmToBytes32(address) {
  const out = new Uint8Array(32);
  const hex = address.toLowerCase().replace(/^0x/, '');
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// Borsh encoding of DepositForBurnWithHookParams, after the instruction discriminator.
function encodeBurnParams({ amount, mintRecipient, maxFee, minFinalityThreshold }) {
  const data = new Uint8Array(8 + 8 + 4 + 32 + 32 + 8 + 4 + 4 + FORWARD_HOOK.length);
  const view = new DataView(data.buffer);
  let o = 0;
  data.set(DEPOSIT_FOR_BURN_WITH_HOOK, o); o += 8;
  view.setBigUint64(o, amount, true); o += 8;
  view.setUint32(o, DOMAIN_BASE, true); o += 4;
  data.set(evmToBytes32(mintRecipient), o); o += 32;
  o += 32; // destination_caller: zero = anyone (required by the forwarder)
  view.setBigUint64(o, maxFee, true); o += 8;
  view.setUint32(o, minFinalityThreshold, true); o += 4;
  view.setUint32(o, FORWARD_HOOK.length, true); o += 4;
  data.set(FORWARD_HOOK, o);
  return data;
}

// Burn `amount` USDC from the owner's USDC account for minting on Base to `mintRecipient`
// (an EVM address), with Circle forwarding. The MessageSent event account is a fresh keypair that
// must co-sign after the wallet (wallets may adjust the transaction when signing); its rent is paid
// by the owner. Returns { tx, eventKeypair }.
export function buildBurnTx({ owner, amount, mintRecipient, maxFee, minFinalityThreshold, blockhash }) {
  const eventAccount = Keypair.generate();
  const keys = [
    { pubkey: owner, isSigner: true, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: true }, // event_rent_payer
    { pubkey: SENDER_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: ata(owner, USDC_MINT), isSigner: false, isWritable: true },
    { pubkey: pda(['denylist_account', owner], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: MESSAGE_TRANSMITTER_STATE, isSigner: false, isWritable: true },
    { pubkey: TOKEN_MESSENGER, isSigner: false, isWritable: false },
    { pubkey: REMOTE_TOKEN_MESSENGER_BASE, isSigner: false, isWritable: false },
    { pubkey: TOKEN_MINTER, isSigner: false, isWritable: false },
    { pubkey: LOCAL_TOKEN_USDC, isSigner: false, isWritable: true },
    { pubkey: USDC_MINT, isSigner: false, isWritable: true },
    { pubkey: eventAccount.publicKey, isSigner: true, isWritable: true },
    { pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false }, // program (Anchor event CPI)
  ];
  const ix = new TransactionInstruction({
    programId: TOKEN_MESSENGER_MINTER,
    keys,
    data: encodeBurnParams({ amount, mintRecipient, maxFee, minFinalityThreshold }),
  });
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  return { tx: new VersionedTransaction(message), eventKeypair: eventAccount };
}

// ---------- Jupiter (USDT → USDC) ----------

const JUPITER = 'https://lite-api.jup.ag/swap/v1';

export async function jupiterQuote(amountIn, slippageBps) {
  const res = await fetch(`${JUPITER}/quote?inputMint=${USDT_MINT}&outputMint=${USDC_MINT}&amount=${amountIn}&slippageBps=${slippageBps}`);
  const q = await res.json();
  if (!q.outAmount) throw new Error(q.error || 'No Jupiter quote');
  return q;
}

// Build the swap for `owner` from a quote; returns { tx, lastValidBlockHeight }. The transaction is built by Jupiter's server, so the caller
// checks its effect by simulation before asking the wallet to sign (see checkSwapBySimulation).
export async function jupiterSwapTx(quote, owner) {
  const res = await fetch(`${JUPITER}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner.toBase58(), dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
  });
  const { swapTransaction, lastValidBlockHeight, error } = await res.json();
  if (!swapTransaction) throw new Error(error || 'Jupiter could not build the swap');
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(swapTransaction), (c) => c.charCodeAt(0)));
  return { tx, lastValidBlockHeight };
}

// SPL token account amount (u64 at offset 64), or 0 when the account doesn't exist.
const tokenAmount = (acct) => {
  if (!acct?.data) return 0n;
  const bytes = Uint8Array.from(atob(acct.data[0]), (c) => c.charCodeAt(0));
  return new DataView(bytes.buffer).getBigUint64(64, true);
};

// Simulate a Jupiter swap and check it does what was quoted: the owner's USDT goes down by exactly
// amountIn and their USDC goes up by at least minOut. Returns the simulated USDC received.
export async function checkSwapBySimulation(rpc, tx, owner, amountIn, minOut) {
  const usdtAta = ata(owner, USDT_MINT), usdcAta = ata(owner, USDC_MINT);
  const before = await rpc('getMultipleAccounts', [[usdtAta.toBase58(), usdcAta.toBase58()], { encoding: 'base64' }]);
  const sim = await rpc('simulateTransaction', [btoa(String.fromCharCode(...tx.serialize())), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [usdtAta.toBase58(), usdcAta.toBase58()] },
  }]);
  if (sim.value.err) throw new Error(`Swap simulation failed: ${JSON.stringify(sim.value.err)}`);
  const [usdtBefore, usdcBefore] = before.value.map(tokenAmount);
  const [usdtAfter, usdcAfter] = sim.value.accounts.map(tokenAmount);
  const received = usdcAfter - usdcBefore;
  if (usdtBefore - usdtAfter !== amountIn || received < minOut) throw new Error('Jupiter swap failed the safety checks');
  return received;
}

export { PublicKey, VersionedTransaction };
