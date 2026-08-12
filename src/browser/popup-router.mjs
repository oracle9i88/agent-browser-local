import { isContributionUrlAllowed } from "../security/contribution-policy.mjs";

export class ContributionPopupRouter {
  constructor(config, { navigate, onRouted = () => {}, onError = () => {} } = {}) {
    this.config = config;
    this.navigate = navigate;
    this.onRouted = onRouted;
    this.onError = onError;
    this.pending = new Set();
  }

  route(url, { close } = {}) {
    if (!isContributionUrlAllowed(this.config, url)) return false;
    if (this.pending.has(url)) return true;
    this.pending.add(url);

    queueMicrotask(async () => {
      try {
        await this.navigate(url);
        close?.();
        this.onRouted();
      } catch (error) {
        this.onError(error);
      } finally {
        this.pending.delete(url);
      }
    });
    return true;
  }
}
