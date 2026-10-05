import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let step: ReturnType<typeof vi.fn<() => Promise<string>>>;

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
    step = vi.fn(async () => ticket);
    const auth = new NegotiateAuthProvider('HTTP/127.0.0.1', {
      GSS_MECH_OID_SPNEGO: 6,
      initializeClient: async () => ({ step }),
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

  it.each([
    Buffer.from('NTLMSSP\0\x01', 'latin1').toString('base64'),
    Buffer.concat([
      Buffer.from([0x60, 0x48, 0x06, 0x06]),
      Buffer.from('NTLMSSP\0\x01', 'latin1'),
    ]).toString('base64'),
    '',
  ])(
    'refuses NTLM or an empty ticket before HTTP traffic (%s)',
    async (token) => {
      step.mockResolvedValue(token);
      const result = await client.callTool({
        name: 'server_info',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: 'NEGOTIATE_NTLM_UNSUPPORTED' },
      });
      expect(ado.requests).toHaveLength(0);
    },
  );

  it('withholds native ticket errors and sends no HTTP request on failure', async () => {
    step.mockRejectedValue(new Error('private-native-ticket-detail'));
    const result = await client.callTool({
      name: 'server_info',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'NEGOTIATE_FAILED' },
    });
    expect(JSON.stringify(result)).not.toContain(
      'private-native-ticket-detail',
    );
    expect(ado.requests).toHaveLength(0);
  });

  it.each(['repo_repository', 'repo_pull_request_write'])(
    'keeps repository authorization for %s when using Kerberos',
    async (name) => {
      const result = await client.callTool({
        name,
        arguments:
          name === 'repo_repository'
            ? { action: 'get', project: 'Website', repository: 'outside-scope' }
            : {
                action: 'create',
                project: 'Website',
                repository: 'outside-scope',
                sourceBranch: 'feature/search',
                targetBranch: 'develop',
                title: 'Unauthorized PR',
              },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: 'REPOSITORY_NOT_ALLOWED' },
      });
      expect(ado.requests.length).toBeGreaterThan(0);
      expect(ado.requests.every((request) => request.method === 'GET')).toBe(
        true,
      );
      expect(
        ado.requests.every(
          (request) => !request.url.pathname.includes('outside-scope'),
        ),
      ).toBe(true);
      expect(ado.pullRequests).toHaveLength(0);
    },
  );

  it('keeps build execution denied with Kerberos and repository approval', async () => {
    const result = await client.callTool({
      name: 'pipelines_write',
      arguments: {
        action: 'run_pipeline',
        project: 'Website',
        repository: 'intranet',
        definitionId: 7,
        branch: 'feature/search',
        commit: 'a'.repeat(40),
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'BUILD_WRITE_SCOPE_REQUIRED' },
    });
    expect(ado.requests).toHaveLength(0);
  });
});
