function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HumanPacedExecutor {
  #tail = Promise.resolve();
  #lastFinishedAt = 0;

  constructor({
    minDelayMs = 850,
    maxDelayMs = 1650,
    random = Math.random,
    now = Date.now,
    wait = sleep,
  } = {}) {
    if (minDelayMs < 0 || maxDelayMs < minDelayMs) {
      throw new Error("Invalid human pacing interval");
    }
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.random = random;
    this.now = now;
    this.wait = wait;
  }

  run(task) {
    const next = this.#tail.then(async () => {
      const spread = this.maxDelayMs - this.minDelayMs;
      const targetDelay = this.minDelayMs + Math.floor(this.random() * (spread + 1));
      const elapsed = this.#lastFinishedAt ? this.now() - this.#lastFinishedAt : targetDelay;
      if (elapsed < targetDelay) await this.wait(targetDelay - elapsed);
      try {
        return await task();
      } finally {
        this.#lastFinishedAt = this.now();
      }
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

