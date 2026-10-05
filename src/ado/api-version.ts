export const API_VERSIONS = {
  '2022': '7.0',
  '2020': '6.0',
  '2019': '5.0',
} as const;

export type ApiVersion =
  (typeof API_VERSIONS)[keyof typeof API_VERSIONS] | '7.1';

export function isApiVersion(value: string): value is ApiVersion {
  return ['7.0', '7.1', '6.0', '5.0'].includes(value);
}

export type Endpoint = 'phase2' | 'workItemComments' | 'identities';
export function endpointVersion(
  version: ApiVersion,
  endpoint: Endpoint,
): string | undefined {
  if (version !== '7.0' && version !== '7.1') return undefined;
  if (endpoint === 'workItemComments') return `${version}-preview.3`;
  if (endpoint === 'identities') return `${version}-preview.1`;
  return version;
}
