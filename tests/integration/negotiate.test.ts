import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { NegotiateAuthProvider } from '../../src/ado/negotiate.js';
import { MockAdoServer } from '../fixtures/ado-server.js';

const ticket = Buffer.from([0x60, 0x82, 0x01, 0x02]).toString('base64');

describe('MCP with Windows integrated (negotiate) authentication', () => {
  let ado: MockAdoServer;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    ado = await new MockAdoServer().start();
    ado.acceptedAuthorization = `Negotiate ${ticket}`;
    const config = loadConfig({
      ADO_SERVER_URL: `${ado.baseUrl}/tfs`,
      ADO_COLLECTION: 'DefaultCollection',
      ADO_AUTH_TYPE: 'negotiate',
      ADO_ALLOWED_REPOSITORIES: JSON.stringify([
        { project: 'Website', repository: 'intranet' },
      ]),
    });
    expect(config.authType).toBe('negotiate');
    const auth = new NegotiateAuthProvider('HTTP/127.0.0.1', {
      GSS_MECH_OID_SPNEGO: 6,
      initializeClient: async () => ({ step: async () => ticket }),
    });
    server = createServer(config, { auth });
    client = new Client({ name: 'negotiate-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await ado.close();
  });

  it('authenticates every request with a Negotiate header and reports the auth type', async () => {
    const result = await client.callTool({
      name: 'server_info',
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      connected: true,
      authType: 'negotiate',
    });
    expect(ado.requests.length).toBeGreaterThan(0);
    for (const request of ado.requests) {
      expect(request.authorization).toBe(`Negotiate ${ticket}`);
    }
  });

  it('gives a credential-neutral hint when the server rejects the ticket', async () => {
    ado.acceptedAuthorization = 'Negotiate something-else';
    const result = await client.callTool({
      name: 'server_info',
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'HTTP_401',
        message: expect.stringContaining('Kerberos ticket and server SPN'),
      },
    });
  });
});
