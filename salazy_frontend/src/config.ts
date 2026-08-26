// Aztec Testnet — the only supported network.
// Populated after the SalAZy contract is deployed.
export const SALAZY_CONTRACT_ADDRESS =
  '0x255a98b810ba651a6284214e36b6d3bc806a1852ea31bfaf460726ae8e7dd44b';

export function getNodeUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_AZTEC_NODE_URL?: string } })
    .env;
  return (
    env?.VITE_AZTEC_NODE_URL || 'https://v5.testnet.rpc.aztec-labs.com'
  );
}
