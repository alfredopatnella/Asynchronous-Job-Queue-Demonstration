import type { APIGatewayProxyEvent } from 'aws-lambda';

const sendMock = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.QUEUE_URL = 'https://sqs.example.com/123456789012/job-queue';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../src/producer/handler');

function makeEvent(body: unknown): APIGatewayProxyEvent {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
  } as APIGatewayProxyEvent;
}

describe('producer handler', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  test('rejects a request missing reportType', async () => {
    const result = await handler(makeEvent({ requestedBy: 'demo@example.com' }));
    expect(result.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('rejects a request missing requestedBy', async () => {
    const result = await handler(makeEvent({ reportType: 'monthly-sales' }));
    expect(result.statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test('rejects malformed JSON', async () => {
    const result = await handler(makeEvent('not json'));
    expect(result.statusCode).toBe(400);
  });

  test('accepts a valid request, enqueues it, and returns 202', async () => {
    const result = await handler(
      makeEvent({ reportType: 'monthly-sales', requestedBy: 'demo@example.com' })
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(202);

    const body = JSON.parse(result.body);
    expect(body.status).toBe('accepted');
    expect(typeof body.jobId).toBe('string');
    expect(body.jobId.length).toBeGreaterThan(0);
  });
});
