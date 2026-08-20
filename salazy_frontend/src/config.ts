// Aztec Testnet — the only supported network.
// Populated after the SalAZy contract is deployed.
export const SALAZY_CONTRACT_ADDRESS =
  '0x0bb0eaedd9fce0f92b63293f179b7b652cf0edfb037840101f987f77d9881af2';

export function getNodeUrl(): string {
  const env = (import.meta as unknown as { env?: { VITE_AZTEC_NODE_URL?: string } })
    .env;
  return (
    env?.VITE_AZTEC_NODE_URL || 'https://v5.testnet.rpc.aztec-labs.com'
  );
}
