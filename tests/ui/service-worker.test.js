import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(`${process.cwd()}/sw.js`, 'utf8');

describe('V1.0 service worker source contract', () => {
  it('uses the explicit V1 cache and a controlled waiting update', () => {
    expect(source).toContain("stardew-todo-v1.0.5");
    expect(source).toContain("message.type === 'SKIP_WAITING'");
    const installHandler = source.match(/addEventListener\('install',[\s\S]*?\n\}\);/)?.[0] || '';
    expect(installHandler).not.toContain('skipWaiting()');
  });

  it('handles Web Push and notification clicks', () => {
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain('showNotification');
    expect(source).toContain("addEventListener('notificationclick'");
  });

  it('only uses index fallback for navigation requests', () => {
    expect(source).toContain("request.mode === 'navigate'");
    expect(source).toContain('networkFirstNavigation');
    expect(source).toContain('ignoreSearch: true');
  });
});
