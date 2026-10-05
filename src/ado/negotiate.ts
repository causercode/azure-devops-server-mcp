import { createRequire } from 'node:module';
import { SafeError } from '../errors.js';
import type { AuthProvider } from './auth.js';

/** The subset of the optional `kerberos` package used here. */
export interface KerberosModule {
  GSS_MECH_OID_SPNEGO: number;
  initializeClient(
    service: string,
    options?: { mechOID?: number },
  ): Promise<{ step(challenge: string): Promise<string> }>;
}

const NTLM_SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');

export function defaultServicePrincipal(
  serverUrl: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const host = new URL(serverUrl).hostname;
  // SSPI takes the SPN form HTTP/host; GSSAPI takes the host-based form HTTP@host.
  return platform === 'win32' ? `HTTP/${host}` : `HTTP@${host}`;
}

export function loadKerberos(): KerberosModule {
  try {
    return createRequire(import.meta.url)('kerberos');
  } catch {
    throw new SafeError(
      'NEGOTIATE_UNAVAILABLE',
      'ADO_AUTH_TYPE=negotiate requires the optional kerberos package and its native binding. Reinstall with optional dependencies and allow its install script (npm 12+: npm install-scripts approve kerberos), or use ADO_AUTH_TYPE=pat.',
    );
  }
}

/**
 * Kerberos via SPNEGO using the signed-in Windows session (SSPI) or a kinit ticket (GSSAPI).
 * Each request gets a fresh single-leg token. NTLM is refused: its challenge/response
 * handshake must stay on one connection, which fetch does not guarantee.
 */
export class NegotiateAuthProvider implements AuthProvider {
  readonly #servicePrincipal: string;
  readonly #kerberos: KerberosModule;

  constructor(
    servicePrincipal: string,
    kerberos: KerberosModule = loadKerberos(),
  ) {
    this.#servicePrincipal = servicePrincipal;
    this.#kerberos = kerberos;
  }

  async getHeaders(): Promise<Record<string, string>> {
    let token: string;
    try {
      const client = await this.#kerberos.initializeClient(
        this.#servicePrincipal,
        { mechOID: this.#kerberos.GSS_MECH_OID_SPNEGO },
      );
      token = await client.step('');
    } catch {
      throw new SafeError(
        'NEGOTIATE_FAILED',
        `Could not obtain a Kerberos ticket for ${this.#servicePrincipal}. Sign in to the domain (or run kinit) and check ADO_KERBEROS_SPN.`,
      );
    }
    if (!token || Buffer.from(token, 'base64').includes(NTLM_SIGNATURE)) {
      throw new SafeError(
        'NEGOTIATE_NTLM_UNSUPPORTED',
        `Windows offered NTLM instead of Kerberos for ${this.#servicePrincipal}. Use a domain-joined machine and check that the SPN is registered for the server (or set ADO_KERBEROS_SPN), or use ADO_AUTH_TYPE=pat.`,
      );
    }
    return { Authorization: `Negotiate ${token}` };
  }
}
