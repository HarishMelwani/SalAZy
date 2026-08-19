// Aztec Testnet — the only supported network.
// Populated after the SalAZy contract is deployed.
export const SALAZY_CONTRACT_ADDRESS =
  '0x29e4f4592c02ec0ae8df74f49ed13212577fd11b992ef6dd73b34bad31846b04';

export function getNodeUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_AZTEC_NODE_URL?: string } })
    .env;
  return (
    env?.VITE_AZTEC_NODE_URL || 'https://v5.testnet.rpc.aztec-labs.com'
  );
}
