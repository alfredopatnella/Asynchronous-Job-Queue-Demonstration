import { randomUUID } from 'node:crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CreateJobRequest, CreateJobResponse, ReportJob } from '../shared/types';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL as string;

/**
 * Accepts a report request over HTTP and hands it off to SQS for
 * asynchronous processing. This function deliberately does NOT generate
 * the report itself -- it only validates, enqueues, and returns. That
 * separation is the entire point of the sample: the caller gets an
 * immediate response instead of waiting on background work.
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  let request: CreateJobRequest;

  try {
    request = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { message: 'Request body must be valid JSON.' });
  }

  if (!request.reportType || typeof request.reportType !== 'string') {
    return jsonResponse(400, { message: '"reportType" is required and must be a string.' });
  }
  if (!request.requestedBy || typeof request.requestedBy !== 'string') {
    return jsonResponse(400, { message: '"requestedBy" is required and must be a string.' });
  }

  const job: ReportJob = {
    jobId: randomUUID(),
    reportType: request.reportType,
    requestedBy: request.requestedBy,
    createdAt: new Date().toISOString(),
    simulateFailure: request.simulateFailure === true,
  };

  console.log('Job accepted', { jobId: job.jobId, reportType: job.reportType });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(job),
    })
  );

  console.log('Job sent to queue', { jobId: job.jobId });

  const response: CreateJobResponse = {
    jobId: job.jobId,
    status: 'accepted',
    message: 'Report generation job queued for asynchronous processing.',
  };

  // 202 Accepted, not 200 OK: the request was accepted for processing,
  // but processing has not happened yet. There is no completed report
  // to return here -- see the "No job-status API" note in the README
  // for why this sample does not expose GET /jobs/{jobId}.
  return jsonResponse(202, response);
};

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
