import { describe, expect, it, vi } from 'vitest';
import {
  NegotiateAuthProvider,
  type KerberosModule,
} from '../../src/ado/negotiate.js';

const kerberosToken = Buffer.from([0x60, 0x82, 0x01, 0x02, 0x06]).toString(
  'base64',
);

function fakeKerberos(step: () => Promise<string>) {
  const initializeClient = vi.fn<KerberosModule['initializeClient']>(
    async () => ({ step }),
  );
  return {
    initializeClient,
    kerberos: { GSS_MECH_OID_SPNEGO: 6, initializeClient },
  };
}

describe('Negotiate (Kerberos) authentication', () => {
  it('sends a fresh SPNEGO token for the configured SPN on every request', async () => {
    const { kerberos, initializeClient } = fakeKerberos(
      async () => kerberosToken,
    );
    const auth = new NegotiateAuthProvider(
      'HTTP/devops.example.test',
      kerberos,
    );
    expect(await auth.getHeaders()).toEqual({
      Authorization: `Negotiate ${kerberosToken}`,
    });
    await auth.getHeaders();
    expect(initializeClient).toHaveBeenCalledTimes(2);
    expect(initializeClient).toHaveBeenCalledWith('HTTP/devops.example.test', {
      mechOID: 6,
    });
  });

  it.each([
    Buffer.from('NTLMSSP\0\x01\0\0\0', 'latin1').toString('base64'),
    // NTLM wrapped in a SPNEGO NegTokenInit.
    Buffer.concat([
      Buffer.from([0x60, 0x48, 0x06, 0x06]),
      Buffer.from('NTLMSSP\0\x01', 'latin1'),
    ]).toString('base64'),
    '',
  ])('refuses an NTLM fallback token instead of sending it', async (token) => {
    const { kerberos } = fakeKerberos(async () => token);
    await expect(
      new NegotiateAuthProvider('HTTP/devops', kerberos).getHeaders(),
    ).rejects.toMatchObject({ code: 'NEGOTIATE_NTLM_UNSUPPORTED' });
  });

  it('reports ticket failures without native error details', async () => {
    const { kerberos } = fakeKerberos(async () => {
      throw new Error('SEC_E_INTERNAL: secret native detail');
    });
    const failure = new NegotiateAuthProvider(
      'HTTP/devops',
      kerberos,
    ).getHeaders();
    await expect(failure).rejects.toMatchObject({
      code: 'NEGOTIATE_FAILED',
      message: expect.stringContaining('HTTP/devops'),
    });
    await expect(failure).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('secret native detail'),
    );
  });
});
