import { readFileSync } from 'node:fs';

const metadata: { name: string; version: string } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
export const SERVER_NAME = metadata.name;
export const SERVER_VERSION = metadata.version;
