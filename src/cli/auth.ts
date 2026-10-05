import {
  systemCredentialStore,
  type CredentialStore,
} from '../ado/credential-store.js';
import { credentialTarget, isValidToken, loadLocation } from '../config.js';
import { SafeError } from '../errors.js';

export interface AuthCommandIo {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
  };
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  credentialStore?: () => CredentialStore;
}

export const AUTH_USAGE = `Usage: azure-devops-server-mcp auth <set-token|clear-token|status> [--server-url URL] [--collection NAME] [--target NAME]

Stores the PAT in the OS credential store (Windows Credential Manager, macOS Keychain, or Secret Service)
so it never appears in MCP client configuration. Then configure ADO_TOKEN_SOURCE=credential-manager.
set-token reads the PAT from a hidden prompt or from standard input; never pass it as an argument.
Flags default to ADO_SERVER_URL, ADO_COLLECTION and ADO_CREDENTIAL_TARGET.
`;

const FLAGS: Record<string, string> = {
  '--server-url': 'ADO_SERVER_URL',
  '--collection': 'ADO_COLLECTION',
  '--target': 'ADO_CREDENTIAL_TARGET',
};

/** Returns the process exit code. Never writes the token to any stream. */
export async function runAuthCommand(
  args: readonly string[],
  io: AuthCommandIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help') {
    io.stdout.write(AUTH_USAGE);
    return command === undefined ? 1 : 0;
  }
  const env: NodeJS.ProcessEnv = { ...io.env };
  for (let index = 0; index < rest.length; index += 2) {
    const name = FLAGS[rest[index] ?? ''];
    const value = rest[index + 1];
    if (!name || value === undefined) {
      throw new SafeError(
        'INVALID_ARGUMENT',
        `Unsupported auth arguments.\n${AUTH_USAGE}`,
      );
    }
    env[name] = value;
  }
  const { serverUrl, collection } = loadLocation(env);
  const target = credentialTarget(env, serverUrl, collection);
  const store = (io.credentialStore ?? systemCredentialStore)();
  switch (command) {
    case 'set-token': {
      const token = await readToken(io);
      if (!isValidToken(token)) {
        throw new SafeError(
          'INVALID_ARGUMENT',
          'The PAT must be non-empty and must not contain whitespace or control characters.',
        );
      }
      store.set(target, token);
      io.stdout.write(
        `Stored the PAT as "${target}". Configure ADO_TOKEN_SOURCE=credential-manager and remove ADO_TOKEN from MCP client configuration.\n`,
      );
      return 0;
    }
    case 'clear-token':
      io.stdout.write(
        store.delete(target)
          ? `Removed the stored PAT "${target}". Revoke the PAT in Azure DevOps if it is no longer needed.\n`
          : `No PAT is stored as "${target}".\n`,
      );
      return 0;
    case 'status': {
      const stored = store.get(target);
      io.stdout.write(
        stored
          ? `A PAT is stored as "${target}".\n`
          : `No PAT is stored as "${target}".\n`,
      );
      return stored ? 0 : 1;
    }
    default:
      throw new SafeError(
        'INVALID_ARGUMENT',
        `Unsupported auth command.\n${AUTH_USAGE}`,
      );
  }
}

async function readToken(io: AuthCommandIo): Promise<string> {
  if (io.stdin.isTTY && io.stdin.setRawMode) return readHidden(io);
  const chunks: Buffer[] = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
}

function readHidden(io: AuthCommandIo): Promise<string> {
  const { stdin } = io;
  io.stderr.write('Personal access token (input hidden): ');
  stdin.setRawMode?.(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stderr.write('\n');
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          finish();
          reject(new SafeError('CANCELLED', 'Cancelled.'));
          return;
        }
        value =
          character === '\u007f' || character === '\b'
            ? value.slice(0, -1)
            : value + character;
      }
    };
    stdin.on('data', onData);
  });
}
