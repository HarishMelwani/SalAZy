// Aztec Testnet — the only supported network.
// Populated after the SalAZy contract is deployed.
export const SALAZY_CONTRACT_ADDRESS =
  '0x2e2e121d397c67e5d018fce15b477511599036eaf24987f3638dad6944ad2015';

export function getNodeUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_AZTEC_NODE_URL?: string } })
    .env;
  return (
    env?.VITE_AZTEC_NODE_URL || 'https://v5.testnet.rpc.aztec-labs.com'
  );
}
