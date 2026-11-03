# sol2base

A static page that moves USDC or USDT from Solana to Base with Circle's CCTP V2. There's no build step and no backend.

Live at https://swapmarket.github.io/sol2base/ · sister project: [eth2base](https://github.com/SwapMarket/eth2base) (Ethereum → Base).

## Flow

1. **Connect** an injected Solana wallet (Phantom, Solflare, Backpack). On phones, open the page in the wallet app's browser
   (the page links to Phantom's and Solflare's).
2. **Optional, pay with USDT**: swap USDT → USDC on Solana via Jupiter's API. Before signing, the page simulates Jupiter's
   transaction and checks that exactly the USDT amount leaves and at least the quoted minimum of USDC arrives.
3. **Burn** USDC with `TokenMessengerMinterV2.deposit_for_burn_with_hook` (destination domain 6 = Base), built in `solana.js`
   from Circle's IDL, with Circle's Forwarding Service hook (`"cctp-forward"`), so **Circle mints on Base** and takes its fee from
   the amount. `maxFee` = protocol fee + forwarding fee (`high` tier from `GET /v2/burn/USDC/fees/5/6?forward=true`); Circle charges
   it in full. The burn is simulated before the wallet is asked to sign.
4. **Track**: poll `GET https://iris-api.circle.com/v2/messages/5?transactionHash=<signature>` until `forwardTxHash` (the Base mint).

**SOL needed**: about 0.003 SOL, mostly rent for the account where CCTP records the message (reclaimable from Circle's program after
5 days), plus network fees; paying with USDT adds the swap fee and, if missing, a USDC token account (~0.002 SOL).

Reads go to public Solana RPCs (publicnode, then Solana's own); transactions are signed by the wallet and sent by the page,
re-sent until confirmed or expired.

## Addresses

| | |
|---|---|
| TokenMessengerMinterV2 (Solana) | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| MessageTransmitterV2 (Solana) | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| USDC / USDT (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` / `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
