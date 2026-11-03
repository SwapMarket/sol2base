# sol2base

A static page that moves USDT or USDC from Solana to Base, without a backend.

Planned flow:

1. **Connect** a Solana wallet (Phantom, Solflare, Backpack; on phones, open the page in the wallet's in-app browser).
2. **Optional, pay with USDT**: swap USDT → USDC on Solana via Jupiter.
3. **Burn** USDC with Circle's CCTP V2 on Solana (`TokenMessengerMinterV2.deposit_for_burn_with_hook`, destination domain 6 = Base),
   with Circle's Forwarding Service hook so Circle mints on Base and takes its fee from the amount.
4. **Track** the transfer through Circle's attestation API until the USDC is minted on Base.

Sister project: [eth2base](https://github.com/SwapMarket/eth2base) (Ethereum → Base).
