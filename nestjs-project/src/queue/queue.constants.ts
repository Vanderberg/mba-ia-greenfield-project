export const PROCESS_VIDEO_QUEUE = 'process-video' as const;

// Dead-letter policy (per phase-03-videos/TD-02): transient failures (worker
// OOM, storage hiccup) get exponential-backoff retries; once attempts are
// exhausted, VideoProcessor's 'failed' listener moves Video.status to
// 'failed' instead of leaving it stuck in 'processing'.
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
} as const;

// Orphan-draft cleanup (per phase-03-videos/TD-04's Context): a Video row
// left in status 'draft' past this TTL never had a completed upload — the
// browser closed before opening the tus session, or abandoned it mid-way.
export const DRAFT_CLEANUP_QUEUE = 'draft-cleanup' as const;
export const DRAFT_CLEANUP_JOB_NAME = 'cleanup-drafts' as const;
export const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;
export const DRAFT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
