import { chromium } from 'playwright-core';
import { ProfileBusyError } from './errors.js';
import { findProfileChromes, killTree } from './procs.js';
import { sleep, withTimeout } from './util.js';

export function launchOptions(cfg, { headless }) {
  return {
    executablePath: cfg.chrome.executablePath,
    headless,
    // Look like a normal Chrome (keeps password-manager behaviour identical to a manual session).
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check', ...(headless ? [] : ['--start-maximized'])],
    viewport: headless ? { width: 1366, height: 850 } : null,
    acceptDownloads: false,
    timeout: 60000,
  };
}

/**
 * Owns the (headless) persistent Chrome on the project profile.
 * Only call when this process holds state/browser.lock, so any other headless Chrome on the
 * profile is an orphan of a crashed owner and can be killed. A headed one is never killed.
 */
export class BrowserManager {
  constructor({ cfg, log, headless = true }) {
    this.cfg = cfg;
    this.log = log;
    this.headless = headless;
    this.ctx = null;
    this.launching = null;
  }

  async getContext() {
    if (this.ctx) return this.ctx;
    if (!this.launching) this.launching = this.#launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  async #launch() {
    const profileDir = this.cfg.chrome.profileDir;
    const others = findProfileChromes(profileDir);
    const headed = others.filter((p) => !p.headless);
    if (headed.length) {
      throw new ProfileBusyError(`有畫面的 Chrome 正在使用爆分監控設定檔（pid ${headed.map((p) => p.pid).join(',')}${headed[0].cdpPort ? `, port ${headed[0].cdpPort}` : ''}）`);
    }
    for (const p of others) {
      this.log.warn(`killing orphan headless Chrome on project profile (pid ${p.pid})`);
      killTree(p.pid);
    }
    if (others.length) await sleep(2000);
    const ctx = await chromium.launchPersistentContext(profileDir, launchOptions(this.cfg, { headless: this.headless }));
    ctx.on('close', () => { if (this.ctx === ctx) this.ctx = null; });
    if (this.headless) {
      // Chrome may restore the previous session's tabs (admin SPAs that poll); close them to save load.
      for (const p of ctx.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => {});
    }
    this.ctx = ctx;
    this.launchedAt = Date.now();
    this.log.info(`Chrome started (${this.headless ? 'headless' : 'headed'})`);
    return ctx;
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx) return;
    try {
      await withTimeout(ctx.close(), 30000, 'Chrome close');
    } catch (error) {
      this.log.warn(`Chrome close problem: ${error.message}`);
    }
  }
}
