import { createRequire } from 'node:module';
import { SafeError } from '../errors.js';

/** OS credential store: Windows Credential Manager, macOS Keychain, or Secret Service. */
export interface CredentialStore {
  get(target: string): string | undefined;
  set(target: string, secret: string): void;
  delete(target: string): boolean;
}

/** The subset of the optional `@napi-rs/keyring` package used here. */
interface KeyringModule {
  Entry: new (
    service: string,
    username: string,
  ) => {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
  };
}

const ACCOUNT = 'ADO_TOKEN';

export function defaultCredentialTarget(
  serverUrl: string,
  collection: string,
): string {
  return `azure-devops-server-mcp:${serverUrl}/${collection}`;
}

export function systemCredentialStore(): CredentialStore {
  let keyring: KeyringModule;
  try {
    keyring = createRequire(import.meta.url)('@napi-rs/keyring');
  } catch {
    throw new SafeError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'ADO_TOKEN_SOURCE=credential-manager requires the optional @napi-rs/keyring package for this platform. Reinstall with optional dependencies, or use ADO_TOKEN_SOURCE=env.',
    );
  }
  // Native errors can include store internals; report only a fixed message.
  const access = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch {
      throw new SafeError(
        'CREDENTIAL_STORE_ERROR',
        'The OS credential store could not be accessed. Check that it is unlocked and available to this user.',
      );
    }
  };
  const entry = (target: string) => new keyring.Entry(target, ACCOUNT);
  return {
    get: (target) => access(() => entry(target).getPassword() ?? undefined),
    set: (target, secret) => access(() => entry(target).setPassword(secret)),
    delete: (target) => access(() => entry(target).deletePassword()),
  };
}
