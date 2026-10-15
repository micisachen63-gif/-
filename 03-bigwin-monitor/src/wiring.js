import { chromium } from 'playwright-core';
import { BrandClient } from './backend.js';
import { BrowserManager } from './browser.js';
import { decryptBackendCreds, DEFAULT_CRED_SCRIPT } from './creds.js';
import { loadAlertBot, loadCommunityBot } from './config.js';
import { createNotifier } from './notifier.js';

/** Real dependencies (Chrome + backends + Telegram config). Tests inject fakes instead. */
export class BackendClientFactory {
  constructor({ cfg, log, headless = true, cdpPort = null }) {
    this.cfg = cfg;
    this.log = log;
    this.cdpPort = cdpPort;
    this.browser = cdpPort ? null : new BrowserManager({ cfg, log, headless });
    this.cdp = null;
    this.clients = new Map();
    this.loadCommunityBot = loadCommunityBot;
  }

  async getContext() {
    if (this.browser) return this.browser.getContext();
    if (!this.cdp) this.cdp = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`, { timeout: 30000 });
    return this.cdp.contexts()[0];
  }

  client(brand) {
    if (!this.clients.has(brand.key)) {
      this.clients.set(brand.key, new BrandClient({
        brand,
        getContext: () => this.getContext(),
        log: this.log.child(brand.key),
        requestTimeoutMs: (this.cfg.requestTimeoutSec ?? 150) * 1000,
        getCredentials: this.cfg.backendCredentials?.enabled === false ? null
          : (b) => decryptBackendCreds(b, { script: this.cfg.backendCredentials?.script || DEFAULT_CRED_SCRIPT }),
      }));
    }
    return this.clients.get(brand.key);
  }

  alertBot() { return loadAlertBot(this.cfg); }

  notifier({ dry, dryWriter, api, chatId }) {
    return createNotifier({ dry, dryWriter, api, chatId, brands: this.cfg.brands, loadCommunityBot, paceMs: 1100 });
  }

  /** ms since our own headless Chrome was launched (null when not running / CDP mode). */
  browserAgeMs() {
    return this.browser?.ctx && this.browser.launchedAt ? Date.now() - this.browser.launchedAt : null;
  }

  async closeBrowser() {
    for (const c of this.clients.values()) await c.closePage().catch(() => {});
    if (this.browser) await this.browser.close();
    // CDP mode: never close someone else's Chrome; process exit just disconnects.
  }
}
