// Aztec Testnet — the only supported network.
// Populated after the SalAZy contract is deployed.
export const SALAZY_CONTRACT_ADDRESS =
  '0x304a74946cac9636c8dabc4e2e8ddb4b37c1bf506d45aa09b78b4bdc754f8967';

export function getNodeUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_AZTEC_NODE_URL?: string } })
    .env;
  return (
    env?.VITE_AZTEC_NODE_URL || 'https://v5.testnet.rpc.aztec-labs.com'
  );
}
