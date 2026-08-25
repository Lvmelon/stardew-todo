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

  it('uses one greeting heart and provides gentle ambient scene layers', async () => {
    const document = await loadDocument();
    const styles = await readFile(`${process.cwd()}/styles.css`, 'utf8');
    const appSource = await readFile(`${process.cwd()}/app.js`, 'utf8');
    expect(document.querySelectorAll('#greeting-cover [aria-hidden="true"]').length).toBe(0);
    expect(document.querySelector('#ambient-life-layer')).not.toBeNull();
    expect(document.querySelector('.couple-heart')).not.toBeNull();
    expect(document.querySelectorAll('.pixel-butterfly').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll('.sky-bird').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll('.wind-leaf').length).toBeGreaterThanOrEqual(3);
    expect(document.querySelectorAll('.ambient-mote').length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('#ambient-motion-enabled')).not.toBeNull();
    expect(document.querySelector('#ambient-motion-status')).not.toBeNull();
    expect(document.querySelector('#ambient-motion-status')?.textContent).toContain('飞鸟');
    expect(document.querySelector('#bgm-play')).not.toBeNull();
    expect(styles).toContain('@keyframes butterflyFlight');
    expect(styles).toContain('@keyframes birdCross');
    expect(styles).toContain('@keyframes leafTumble');
    expect(document.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('styles.css?v=1.0.5');
    expect(document.querySelector('script[type="module"]')?.getAttribute('src')).toBe('app.js?v=1.0.5');
    expect(appSource).toContain("'./update-manager.js?v=1.0.5'");
    expect(appSource).toContain("'./config.js?v=1.0.5'");
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:reduce\)\s*\{#ambient-life-layer\{display:none!important\}\}/);
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
    expect(document.querySelector('#app-version')?.textContent).toContain('V1.0.5');
  });
});
