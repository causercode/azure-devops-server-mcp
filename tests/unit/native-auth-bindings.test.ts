import { beforeEach, describe, expect, it, vi } from 'vitest';
import { systemCredentialStore } from '../../src/ado/credential-store.js';
import { loadKerberos } from '../../src/ado/negotiate.js';

const { loadBinding } = vi.hoisted(() => ({ loadBinding: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => loadBinding }));

describe('optional native authentication bindings', () => {
  beforeEach(() => {
    loadBinding.mockReset();
  });

  it.each([
    [systemCredentialStore, 'CREDENTIAL_STORE_UNAVAILABLE'],
    [loadKerberos, 'NEGOTIATE_UNAVAILABLE'],
  ])('reports a safe error when a binding cannot load', (load, code) => {
    loadBinding.mockImplementation(() => {
      throw new Error('private-native-loader-detail');
    });
    expect(load).toThrow(expect.objectContaining({ code }));
    expect(load).toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining('private-native-loader-detail'),
      }),
    );
  });

  function binding() {
    const entry = {
      getPassword: vi.fn<() => string | null>(() => null),
      setPassword: vi.fn<(secret: string) => void>(),
      deletePassword: vi.fn(() => true),
    };
    const Entry = vi.fn(function () {
      return entry;
    });
    loadBinding.mockReturnValue({ Entry });
    return { entry, Entry, store: systemCredentialStore() };
  }

  it('uses the requested target and account for each native operation', () => {
    const { entry, Entry, store } = binding();
    expect(store.get('test-target')).toBeUndefined();
    entry.getPassword.mockReturnValue('synthetic-pat');
    expect(store.get('test-target')).toBe('synthetic-pat');
    store.set('test-target', 'synthetic-pat');
    expect(entry.setPassword).toHaveBeenCalledWith('synthetic-pat');
    expect(store.delete('test-target')).toBe(true);
    entry.deletePassword.mockReturnValue(false);
    expect(store.delete('test-target')).toBe(false);
    expect(Entry.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ['test-target', 'ADO_TOKEN']),
    );
  });

  it('withholds native constructor errors', () => {
    loadBinding.mockReturnValue({
      Entry: class {
        constructor() {
          throw new Error('private-store-constructor-detail');
        }
      },
    });
    const store = systemCredentialStore();
    expect(() => store.get('test-target')).toThrow(
      expect.objectContaining({
        code: 'CREDENTIAL_STORE_ERROR',
        message: expect.not.stringContaining(
          'private-store-constructor-detail',
        ),
      }),
    );
  });

  it.each(['get', 'set', 'delete'] as const)(
    'withholds native %s errors',
    (operation) => {
      const { entry, store } = binding();
      const fail = () => {
        throw new Error('private-store-operation-detail synthetic-pat');
      };
      entry.getPassword.mockImplementation(fail);
      entry.setPassword.mockImplementation(fail);
      entry.deletePassword.mockImplementation(fail);
      expect(() => store[operation]('test-target', 'synthetic-pat')).toThrow(
        expect.objectContaining({
          code: 'CREDENTIAL_STORE_ERROR',
          message:
            'The OS credential store could not be accessed. Check that it is unlocked and available to this user.',
        }),
      );
    },
  );
});
