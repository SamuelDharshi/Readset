import type { Hex, TxRequest } from '@readset/core';

export interface BuildTxInput {
  from: Hex;
  to: Hex;
  data?: string;
  /** Decimal wei, as it arrives from a CLI flag. */
  value?: string;
  chainId: number;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/**
 * Turns CLI strings into a TxRequest, rejecting malformed input before it reaches the gate.
 * A bad address or odd-length calldata would otherwise surface as an opaque RPC error.
 */
export function buildTx(i: BuildTxInput): TxRequest {
  if (!HEX_ADDRESS.test(i.from)) throw new Error(`--from is not an address: ${i.from}`);
  if (!HEX_ADDRESS.test(i.to)) throw new Error(`--to is not an address: ${i.to}`);
  const data = i.data === undefined || i.data === '' ? undefined : i.data;
  if (data !== undefined && !HEX_DATA.test(data)) {
    throw new Error(`--data is not even-length hex calldata: ${data}`);
  }
  let value: bigint | undefined;
  if (i.value !== undefined && i.value !== '') {
    if (!/^\d+$/.test(i.value)) throw new Error(`--value must be decimal wei, got "${i.value}"`);
    value = BigInt(i.value);
  }
  if (!Number.isInteger(i.chainId) || i.chainId <= 0) throw new Error(`bad chain id: ${i.chainId}`);
  return {
    from: i.from.toLowerCase() as Hex,
    to: i.to.toLowerCase() as Hex,
    ...(data === undefined ? {} : { data: data as Hex }),
    ...(value === undefined ? {} : { value }),
    chainId: i.chainId,
  };
}
