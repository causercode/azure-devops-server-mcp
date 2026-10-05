import type { AdoClient } from '../ado/client.js';
import { listSchema } from '../ado/types.js';
import { identitySchema } from '../ado/phase2-types.js';
import { SafeError } from '../errors.js';
import { page } from './bounds.js';

/** Explicit IDs only for writes; a search never automatically selects a person. */
export class IdentityService {
  constructor(private readonly client: AdoClient) {}
  async search(search: string, top: number, skip: number) {
    const result = (
      await this.client.request(
        ['_apis', 'identities'],
        listSchema(identitySchema),
        {
          endpoint: 'identities',
          query: {
            searchFilter: 'General',
            filterValue: search,
            queryMembership: 'None',
          },
        },
      )
    ).data.value.filter((identity) => this.isPerson(identity));
    return {
      ...page(
        result.map((identity) => this.summary(identity)),
        top,
        skip,
      ),
      selectionNote:
        'Select an explicit person ID after checking the account name. A display name or search match is never assigned automatically.',
    };
  }
  async person(id: string) {
    const result = (
      await this.client.request(
        ['_apis', 'identities'],
        listSchema(identitySchema),
        {
          endpoint: 'identities',
          query: { identityIds: id, queryMembership: 'None' },
        },
      )
    ).data.value;
    if (
      result.length !== 1 ||
      result[0]!.id.toLowerCase() !== id.toLowerCase() ||
      !this.isPerson(result[0]!)
    )
      throw new SafeError(
        'IDENTITY_NOT_FOUND',
        'The explicit identity ID must resolve to exactly one active person. Search identities and verify the account before assigning a reviewer.',
      );
    return this.summary(result[0]!);
  }
  private isPerson(identity: ReturnType<typeof identitySchema.parse>): boolean {
    // Server may omit the false isContainer flag. Require positive person evidence.
    return (
      identity.isActive &&
      identity.isContainer !== true &&
      (identity.isContainer === false ||
        identity.properties?.SchemaClassName?.$value === 'User')
    );
  }
  private summary(identity: ReturnType<typeof identitySchema.parse>) {
    const property = (key: string) =>
      typeof identity.properties?.[key]?.$value === 'string'
        ? String(identity.properties[key]!.$value).slice(0, 256)
        : null;
    return {
      id: identity.id,
      displayName: (
        identity.customDisplayName ||
        identity.providerDisplayName ||
        ''
      ).slice(0, 256),
      accountName: property('Account'),
      domain: property('Domain'),
      mail: property('Mail'),
      isActive: identity.isActive,
    };
  }
}
