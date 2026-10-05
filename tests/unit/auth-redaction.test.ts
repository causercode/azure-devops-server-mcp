import { describe, expect, it } from 'vitest';
import { ToolSecretRedactor } from '../../src/ado/auth.js';
import { createToolRunner } from '../../src/tools/shared.js';
import { SafeError } from '../../src/errors.js';

describe('tool-scoped credential redaction', () => {
  it('redacts every ticket from sequential and concurrent requests, including encoded forms', async () => {
    const secrets = new ToolSecretRedactor(['static-pat']);
    const run = createToolRunner(
      (text) => secrets.redact(text),
      (op) => secrets.run(op),
    );
    const tickets = ['first/ticket+value=', 'second/ticket+value='];
    const result = await run(async () => {
      await Promise.all(
        tickets.map(async (ticket) => {
          await Promise.resolve();
          secrets.capture({ Authorization: `Negotiate ${ticket}` });
        }),
      );
      return {
        labels: [...tickets, ...tickets.map(encodeURIComponent), 'static-pat'],
      };
    });
    const output = JSON.stringify(result);
    for (const ticket of tickets) {
      expect(output).not.toContain(ticket);
      expect(output).not.toContain(encodeURIComponent(ticket));
    }
    expect(result.structuredContent).toEqual({
      labels: Array(5).fill('[REDACTED]'),
    });
  });

  it('isolates simultaneous tool calls and releases their tickets after serialization', async () => {
    const secrets = new ToolSecretRedactor([]);
    const run = createToolRunner(
      (text) => secrets.redact(text),
      (op) => secrets.run(op),
    );
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(async () => {
      secrets.capture({ authorization: 'Negotiate private-ticket-one' });
      await ready;
      return { own: 'private-ticket-one', other: 'private-ticket-two' };
    });
    const second = await run(async () => {
      secrets.capture({ Authorization: 'Negotiate private-ticket-two' });
      release();
      return { own: 'private-ticket-two', other: 'private-ticket-one' };
    });
    expect(second.structuredContent).toEqual({
      own: '[REDACTED]',
      other: 'private-ticket-one',
    });
    expect((await first).structuredContent).toEqual({
      own: '[REDACTED]',
      other: 'private-ticket-two',
    });
    expect(secrets.redact('private-ticket-one private-ticket-two')).toBe(
      'private-ticket-one private-ticket-two',
    );
  });

  it('redacts safe errors and ignores empty or unrelated headers', async () => {
    const secrets = new ToolSecretRedactor([]);
    const run = createToolRunner(
      (text) => secrets.redact(text),
      (op) => secrets.run(op),
    );
    const result = await run(async () => {
      secrets.capture({ Authorization: '', Accept: 'application/json' });
      secrets.capture({ Authorization: 'Negotiate error-ticket' });
      throw new SafeError('TEST_ERROR', 'Reflected Negotiate error-ticket');
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('error-ticket');
    expect(result.structuredContent).toEqual({
      error: { code: 'TEST_ERROR', message: 'Reflected [REDACTED]' },
    });
  });
});
