import type { CelesTrakResponse } from '@/services/celestrakService';

export function parseTleResponsePayload(payload: unknown, status: number): CelesTrakResponse {
  if (
    !payload
    || typeof payload !== 'object'
    || typeof (payload as Partial<CelesTrakResponse>).isConnected !== 'boolean'
    || !Array.isArray((payload as Partial<CelesTrakResponse>).tles)
  ) {
    throw new Error(`Invalid CelesTrak response (${status})`);
  }

  return payload as CelesTrakResponse;
}

/** HTTP errors may still carry the complete, useful CelesTrak response contract. */
export async function readTleResponse(response: Response): Promise<CelesTrakResponse> {
  return parseTleResponsePayload(await response.json() as unknown, response.status);
}
