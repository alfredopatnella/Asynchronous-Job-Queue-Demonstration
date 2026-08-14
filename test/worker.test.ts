import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { handler } from '../src/worker/handler';
import { ReportJob } from '../src/shared/types';

function makeRecord(messageId: string, job: ReportJob): SQSRecord {
  return {
    messageId,
    body: JSON.stringify(job),
    attributes: { ApproximateReceiveCount: '1' },
  } as unknown as SQSRecord;
}

function makeJob(overrides: Partial<ReportJob> = {}): ReportJob {
  return {
    jobId: 'job-1',
    reportType: 'monthly-sales',
    requestedBy: 'demo@example.com',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('worker handler', () => {
  test('a fully successful batch reports no batch item failures', async () => {
    const event: SQSEvent = {
      Records: [
        makeRecord('msg-a', makeJob({ jobId: 'a' })),
        makeRecord('msg-b', makeJob({ jobId: 'b' })),
      ],
    };

    const result = await handler(event);

    expect(result.batchItemFailures).toEqual([]);
  });

  test('only the failing message is reported back, not the whole batch', async () => {
    const event: SQSEvent = {
      Records: [
        makeRecord('msg-a', makeJob({ jobId: 'a' })),
        makeRecord('msg-b', makeJob({ jobId: 'b' })),
        makeRecord('msg-c', makeJob({ jobId: 'c', simulateFailure: true })),
        makeRecord('msg-d', makeJob({ jobId: 'd' })),
        makeRecord('msg-e', makeJob({ jobId: 'e' })),
      ],
    };

    const result = await handler(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-c' }]);
  });

  test('simulateFailure fails only that record', async () => {
    const event: SQSEvent = {
      Records: [makeRecord('msg-fail', makeJob({ simulateFailure: true }))],
    };

    const result = await handler(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-fail' }]);
  });
});
