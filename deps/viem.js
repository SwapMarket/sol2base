// The parts of viem the page uses (named, so the bundle leaves out the rest).
export {
  createPublicClient, createWalletClient, custom, fallback, http,
  parseAbi, parseAbiItem, parseEventLogs, encodeFunctionData,
  getAddress, isAddress, zeroHash,
} from 'viem';
export { base } from 'viem/chains';
