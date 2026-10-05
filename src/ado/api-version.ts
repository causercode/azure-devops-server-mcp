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
