export interface ChannelExternalMonitorLoop {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export interface ChannelExternalMonitorLoopOptions {
  label: string;
  intervalMs: number;
  run(): Promise<void>;
  initial?: boolean;
}

export function createChannelExternalMonitorLoop(options: ChannelExternalMonitorLoopOptions): ChannelExternalMonitorLoop {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await options.run();
    } catch (error) {
      console.error(`Failed to monitor ${options.label} external activity:`, error);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) {
        return;
      }
      if (options.initial ?? true) {
        setTimeout(() => void tick(), 0).unref?.();
      }
      timer = setInterval(() => void tick(), options.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
