# sol2base

A static page that moves USDC or USDT from Solana to Base, or USDC or EURC from Base to Solana, with Circle's CCTP V2. There's no backend, and the only build step is the deploy's `build.sh`.

Live at https://swapmarket.github.io/sol2base/ · sister project: [eth2base](https://github.com/SwapMarket/eth2base) (Ethereum → Base).

## Flow

1. **Connect** a Solana wallet: through the Wallet Standard (Phantom, Solflare, Backpack, Trust Wallet…), the wallets' older
   injected objects as a fallback, or **WalletConnect** for a phone wallet by QR code (`solana_signTransaction`; e.g. Trust Wallet,
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

## Base → Solana

1. **Connect** a Base wallet (injected, or the WalletConnect session's Base account). The recipient is the connected Solana
   wallet or any Solana wallet address entered; a token-account address is refused.
   **Optional, pay with EURC**: the Base wallet first swaps EURC → USDC on Aerodrome Slipstream (0.5% max slippage), then burns
   the USDC it got.
2. **Burn** USDC with `TokenMessengerV2.depositForBurnWithHook` on Base (destination domain 5), after a USDC approval and a
   simulation. CCTP mints to a token account, so `mintRecipient` is the recipient's USDC associated token account. The hook is
   Circle's forwarding hook; when that account doesn't exist yet it uses the account-creation variant (`"cctp-forward"`, version 0,
   length 33, `0x01`, the owner's 32-byte key) and the fee comes from `GET /v2/burn/USDC/fees/6/5?forward=true&includeRecipientSetup=true`,
   so **Circle creates the account and mints**: the recipient needs no SOL. Needs a little ETH on Base for the two transactions.
3. **Track**: `GET /v2/messages/6?transactionHash=<hash>` until `forwardTxHash` (the Solana mint).
4. **Optional, receive USDT**: the USDC is minted to the connected Solana wallet, which then swaps exactly the minted amount to
   USDT with Jupiter (checked by simulation, as for USDT → USDC). Needs about 0.003 SOL: network fees, plus a USDT account if missing. Standard speed waits for Base
   finality (about 15–20 minutes); fast takes seconds. Resume accepts the Base transaction hash.

**SOL needed**: about 0.003 SOL, mostly rent for the account where CCTP records the message (reclaimable from Circle's program after
5 days), plus network fees; paying with USDT adds the swap fee and, if missing, a USDC token account (~0.002 SOL).

**Reclaiming the rent**: the page remembers each burn's message account in the browser (and finds earlier ones in the wallet's recent
history on connect, since public RPCs can't search old history or list accounts by owner). Once an account is 5 days old, **Reclaim**
calls `MessageTransmitterV2.reclaim_event_account` with Circle's attestation and destination message, returning the ~0.003 SOL.

Reads go to public Solana RPCs (publicnode, then Solana's own); transactions are signed by the wallet and sent by the page,
re-sent until confirmed or expired.

## Deploy and file pinning

`build.sh <commit>` (run by the Pages workflow) copies the files into `_site/`, stamps the commit into `index.html`, and writes
the SHA-384 of `app.js`, `solana.js`, `base.js` and `style.css` into it as Subresource Integrity: `integrity` attributes on the
script and stylesheet, and the import map's `integrity` field for the two modules. The browser refuses a file whose content
doesn't match (import-map integrity needs Chrome 127+, Safari 18+ or Firefox 138+; older browsers load the modules unchecked).
Opened straight from the repo, the placeholders aren't valid hashes, so the browser ignores them (with a console warning).
Not pinned: `sw.js` (service workers can't carry integrity), `icon.png`, and the libraries loaded from esm.sh.

## Addresses

| | |
|---|---|
| TokenMessengerMinterV2 (Solana) | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| MessageTransmitterV2 (Solana) | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| USDC / USDT (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` / `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
