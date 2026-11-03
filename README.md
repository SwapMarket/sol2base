# sol2base

A static page that moves USDC or USDT from Solana to Base with Circle's CCTP V2. There's no build step and no backend.

Live at https://swapmarket.github.io/sol2base/ · sister project: [eth2base](https://github.com/SwapMarket/eth2base) (Ethereum → Base).

## Flow

1. **Connect** a Solana wallet: through the Wallet Standard (Phantom, Solflare, Backpack, Trust Wallet…), the wallets' older
   injected objects as a fallback, or **QR** for a phone wallet over WalletConnect (`solana_signTransaction`; e.g. Trust Wallet,
   not Phantom). On phones, the page can also be opened in Phantom's, Solflare's or Trust Wallet's in-app browser.
2. **Optional, pay with USDT**: swap USDT → USDC on Solana via Jupiter's API. Before signing, the page simulates Jupiter's
   transaction and checks that exactly the USDT amount leaves and at least the quoted minimum of USDC arrives.
3. **Burn** USDC with `TokenMessengerMinterV2.deposit_for_burn_with_hook` (destination domain 6 = Base), built in `solana.js`
   from Circle's IDL, with Circle's Forwarding Service hook (`"cctp-forward"`), so **Circle mints on Base** and takes its fee from
   the amount. `maxFee` = protocol fee + forwarding fee (`high` tier from `GET /v2/burn/USDC/fees/5/6?forward=true`); Circle charges
   it in full. The burn is simulated before the wallet is asked to sign.
4. **Track**: poll `GET https://iris-api.circle.com/v2/messages/5?transactionHash=<signature>` until `forwardTxHash` (the Base mint).
5. **Optional, receive EURC**: needs a Base wallet — the WalletConnect session's Base account (one QR covers both chains, e.g. Trust
   Wallet) or an injected one (Rabby, MetaMask, Phantom). The USDC is minted to that wallet, which then swaps it on Aerodrome Slipstream
   (`base.js`, ported from eth2base) and sends the EURC to the recipient (the Base wallet by default). Optional gas top-up: 0.20 USDC
   swapped to ETH for the Base wallet in the same transaction, pre-ticked when its ETH covers fewer than 4 swaps. EURC is disabled when
   the Base wallet can't pay the swap gas at the current price.
   **Swap all Base USDC to EURC**: a button under the Base balances swaps the Base wallet's whole USDC balance (e.g. left from
   earlier USDC transfers) the same way, to the recipient or the Base wallet.

**SOL needed**: about 0.003 SOL, mostly rent for the account where CCTP records the message (reclaimable from Circle's program after
5 days), plus network fees; paying with USDT adds the swap fee and, if missing, a USDC token account (~0.002 SOL).

**Reclaiming the rent**: the page remembers each burn's message account in the browser (and finds earlier ones in the wallet's recent
history on connect, since public RPCs can't search old history or list accounts by owner). Once an account is 5 days old, **Reclaim**
calls `MessageTransmitterV2.reclaim_event_account` with Circle's attestation and destination message, returning the ~0.003 SOL.

Reads go to public Solana RPCs (publicnode, then Solana's own); transactions are signed by the wallet and sent by the page,
re-sent until confirmed or expired.

## Addresses

| | |
|---|---|
| TokenMessengerMinterV2 (Solana) | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| MessageTransmitterV2 (Solana) | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| USDC / USDT (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` / `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
