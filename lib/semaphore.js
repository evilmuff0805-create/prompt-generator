'use strict';

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    while (this.active >= this.max) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const maxJobs = parseInt(process.env.STORYBOARD_MAX_CONCURRENT_JOBS || '5', 10);
module.exports = new Semaphore(maxJobs);
