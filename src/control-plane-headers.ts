// The two headers every control-plane internal call carries: the bearer the
// network group asks for, and the secret that proves the caller is the bridge
// acting for an assistant.

export interface ControlPlaneCredentials {
  internalSecret: string;
  bridgeSecret: string;
}

/** The headers for one control-plane call. */
export function controlPlaneHeaders(credentials: ControlPlaneCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.internalSecret}`,
    "X-Cerase-Bridge-Secret": credentials.bridgeSecret,
  };
}
