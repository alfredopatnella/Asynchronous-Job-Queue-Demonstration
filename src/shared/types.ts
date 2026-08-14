/**
 * The message shape that flows from the Producer Lambda, through SQS,
 * to the Worker Lambda. Keep this small and free of sensitive data --
 * anything placed on the queue may also land in the DLQ, CloudWatch
 * logs, or be re-delivered more than once (see docs/security.md).
 */
export interface ReportJob {
  jobId: string;
  reportType: string;
  requestedBy: string;
  createdAt: string;
  /** Demonstration-only flag: forces the worker to fail this job on purpose. */
  simulateFailure?: boolean;
}

/** Shape of the JSON body accepted by POST /jobs. */
export interface CreateJobRequest {
  reportType: string;
  requestedBy: string;
  simulateFailure?: boolean;
}

/** Shape of the JSON body returned by POST /jobs. */
export interface CreateJobResponse {
  jobId: string;
  status: 'accepted';
  message: string;
}
