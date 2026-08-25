import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

async function loadDocument() {
  const html = await readFile(`${process.cwd()}/index.html`, 'utf8');
  return new JSDOM(html).window.document;
}

describe('V1.0 application shell', () => {
  it('keeps the confirmed scene and adds small wooden entry points', async () => {
    const document = await loadDocument();
    expect(document.querySelector('#scene-art')?.getAttribute('src')).toBe('assets/scene.webp');
    expect(document.querySelector('#settings-button')).not.toBeNull();
    expect(document.querySelector('#shared-button')).not.toBeNull();
    expect(document.querySelector('#plant-progress')).not.toBeNull();
  });

  it('contains reminder controls and the V1 settings sections', async () => {
    const document = await loadDocument();
    expect(document.querySelector('#task-start-date-input')).not.toBeNull();
    expect(document.querySelector('#task-reminder-mode')).not.toBeNull();
    expect(document.querySelector('#task-reminder-at')).not.toBeNull();
    for (const section of ['notifications', 'sync', 'weather', 'display', 'sound', 'data', 'about']) {
      expect(document.querySelector(`[data-settings-section="${section}"]`)).not.toBeNull();
    }
  });

  it('lets the task icon be chosen from presets or typed freely', async () => {
    const document = await loadDocument();
    expect(document.querySelector('#task-emoji-input')).not.toBeNull();
    expect(document.querySelectorAll('[data-task-emoji]').length).toBeGreaterThanOrEqual(8);
  });

  it('provides shared tasks, comments, and a controlled update prompt', async () => {
    const document = await loadDocument();
    expect(document.querySelector('#shared-modal')).not.toBeNull();
    expect(document.querySelector('#comment-form')).not.toBeNull();
    expect(document.querySelector('#update-banner')).not.toBeNull();
    expect(document.querySelector('#app-version')?.textContent).toContain('V1.0.1');
  });
});
