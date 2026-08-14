import { SQSEvent, SQSBatchResponse, SQSBatchItemFailure, SQSRecord } from 'aws-lambda';
import { ReportJob } from '../shared/types';

/**
 * Triggered by the SQS event source mapping, which is a Lambda-managed
 * poller -- SQS does not invoke Lambda directly. The mapping pulls a
 * batch of messages and delivers them here in a single invocation.
 *
 * Each record is processed independently and failures are reported back
 * individually via `batchItemFailures` (the SQS "partial batch response"
 * feature, enabled on the event source mapping with
 * reportBatchItemFailures: true). Without this, throwing once would tell
 * SQS to retry the ENTIRE batch, including messages that already
 * succeeded.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('Job processing failed', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : error,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  console.log('Batch complete', {
    batchSize: event.Records.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const job: ReportJob = JSON.parse(record.body);

  // ApproximateReceiveCount grows by one on every delivery attempt, so it
  // is the best signal in logs for spotting a message that is retrying.
  const receiveCount = record.attributes?.ApproximateReceiveCount;

  console.log('Processing job', {
    jobId: job.jobId,
    reportType: job.reportType,
    receiveCount,
  });

  // --- Idempotency (production concern, not implemented here) ---
  // SQS provides at-least-once delivery: the same message can be
  // delivered more than once (e.g. the worker finished but the delete
  // call never reached SQS before the visibility timeout expired). In
  // production this is where you would guard against repeating side
  // effects:
  //
  //   1. Look up job.jobId in an idempotency store (e.g. DynamoDB).
  //   2. If it is already marked COMPLETED, return successfully without
  //      redoing the work.
  //   3. Otherwise, do the work.
  //   4. Atomically record completion (e.g. a conditional PutItem).
  //
  // See docs/architecture.md and README.md for the full discussion.

  await processJob(job);
}

async function processJob(job: ReportJob): Promise<void> {
  if (job.simulateFailure) {
    console.log(`Simulated failure for job ${job.jobId}`);
    throw new Error(`Simulated failure for job ${job.jobId}`);
  }

  // Stand-in for real report generation. No file is actually produced --
  // the point of this sample is the queueing/retry mechanics, not report
  // rendering.
  await delay(200);

  console.log(`Report generation complete for job ${job.jobId}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
