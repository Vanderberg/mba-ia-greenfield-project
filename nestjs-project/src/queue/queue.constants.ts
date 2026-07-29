export const PROCESS_VIDEO_QUEUE = 'process-video' as const;

// Dead-letter policy (per phase-03-videos/TD-02): transient failures (worker
// OOM, storage hiccup) get exponential-backoff retries; once attempts are
// exhausted, VideoProcessor's 'failed' listener moves Video.status to
// 'failed' instead of leaving it stuck in 'processing'.
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
} as const;
