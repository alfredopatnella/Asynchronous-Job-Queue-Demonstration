# Troubleshooting

🌐 Language: **English** | [Español](es/troubleshooting.md)

A practical guide for diagnosing the most common issues when running or
demonstrating this stack.

## API returns 5xx

**Check, in order:**

1. **Producer Lambda logs** (CloudWatch Logs, log group
   `/aws/lambda/job-queue-producer`). Look for a stack trace — most 5xxs
   are an unhandled exception in the producer, often from the SQS SDK call.
2. **`sqs:SendMessage` permissions**. If the producer's IAM role or the
   `QUEUE_URL` environment variable is wrong (e.g. pointing at a queue in
   another stack/account), `SendMessageCommand` will throw. Confirm
   `QUEUE_URL` matches the `JobQueueUrl` stack output.
3. **Malformed request payload**. A 400 (not 5xx) is expected for a bad
   body — this is the producer's own validation working correctly, not a
   bug. If you see 5xx instead of 400 for a bad body, the handler itself is
   throwing before validation runs; check for a JSON parsing issue upstream
   of the `try`/`catch` in `src/producer/handler.ts`.

## Messages remain in the queue (not being processed)

**Check, in order:**

1. **Event source mapping state**. In the Lambda console, open the worker
   function's "Triggers" tab and confirm the SQS trigger shows `Enabled`,
   not `Disabled`.
2. **Worker errors**. If the worker function itself is crashing (not just
   individual jobs failing), the entire batch fails and nothing gets
   deleted. Check `/aws/lambda/job-queue-worker` logs for exceptions
   outside the per-record `try`/`catch` in `handler.ts` (e.g. a bad
   deployment, a missing dependency after bundling).
3. **Reserved concurrency**. `reservedConcurrentExecutions: 2` means only 2
   invocations run at once. If the queue has a large backlog, this is
   expected — messages wait their turn. This is backpressure working as
   designed, not a bug.
4. **Throttling**. If you see `Rate Exceeded` or throttling errors on the
   worker, something (often reserved concurrency being fully consumed by
   another workload sharing the account, or an account-level concurrency
   limit) is preventing invocations. Check the Lambda function's
   `Throttles` metric in CloudWatch.

## A message keeps retrying

**Check, in order:**

1. **Worker logs for that job's `jobId`**. Confirm whether `processJob()`
   is actually throwing, and why.
2. **`ApproximateReceiveCount`**. Each retry increments this. The worker
   logs it on every processing attempt — search logs for the `jobId` to see
   the count climbing (1, 2, 3...).
3. **Deliberate `simulateFailure`**. If you submitted the job with
   `"simulateFailure": true`, this is expected: it's designed to fail every
   time, on purpose, so you can observe the retry → DLQ path end to end.
4. **Visibility timeout**. If jobs are retrying *unexpectedly fast* or
   *overlapping* with themselves, confirm the queue's visibility timeout
   (90s) is still comfortably larger than the worker's actual processing
   time (should be well under the 15s function timeout). If someone lowers
   the visibility timeout without lowering the function timeout to match,
   a slow-but-successful job can be redelivered to a second worker while
   the first one is still running.
5. **Redrive policy**. Confirm `maxReceiveCount` on the main queue's
   redrive policy is still 3, and that it points at the correct DLQ ARN
   (`cdk diff` will show you the current template if you're unsure what's
   deployed).

## Messages appear in the DLQ

This means the message was received and failed **3 times** (the configured
`maxReceiveCount`) — retries were exhausted, not a one-off blip. To
investigate:

1. Read the message body in the DLQ (via the SQS console or CLI) to get
   the `jobId` and job details.
2. Search CloudWatch Logs for that `jobId` across all 3 attempts to see why
   it kept failing (`simulateFailure: true`? a real bug? a downstream
   dependency issue in a modified worker?).
3. The DLQ does **not** fix or retry anything by itself. Once you
   understand and fix the root cause, you'd manually redrive the message
   (e.g. using SQS's built-in "start message move task" redrive feature)
   back to the main queue, or discard it if it's no longer relevant.

## The entire batch appears to retry (not just the failing message)

This means partial batch responses aren't taking effect. Check:

1. The event source mapping has `reportBatchItemFailures: true`
   (`FunctionResponseTypes: ["ReportBatchItemFailures"]` in the synthesized
   CloudFormation — verify with `cdk synth` or the console).
2. The worker handler is returning `{ batchItemFailures: [...] }` and not
   throwing an unhandled exception for the whole batch. A thrown exception
   at the top level of `handler()` (as opposed to inside the per-record
   `try`/`catch`) will fail the entire invocation regardless of the
   `reportBatchItemFailures` setting.
3. Each failure entry uses the correct field name and value:
   `itemIdentifier` must exactly match the record's `messageId`.

## Worker appears to run multiple times for the same job

This is expected under SQS's **at-least-once delivery** model — it is not
necessarily a bug. Common causes:

- The worker succeeded, but the delete acknowledgment was lost or delayed
  past the visibility timeout, so SQS redelivered the (already-processed)
  message.
- `simulateFailure: true` deliberately causes redelivery.
- The visibility timeout was too short relative to actual processing time.

The fix is architectural, not a one-off patch: production workers should be
idempotent (see the "Why Idempotency Matters" section in the README and the
comments in `src/worker/handler.ts`).

## CloudFormation deployment fails (`cdk deploy`)

**Check, in order:**

1. **Credentials**. Run `aws sts get-caller-identity` to confirm you're
   authenticated as the account/role you expect.
2. **Region**. Confirm `AWS_REGION`/`AWS_DEFAULT_REGION` (or your CLI
   profile's configured region) is the one you intend to deploy into.
3. **CDK bootstrap**. If you see an error mentioning a missing bootstrap
   stack or SSM parameter (`/cdk-bootstrap/...`), run
   `npx cdk bootstrap aws://ACCOUNT-ID/REGION` once for that
   account/region, then retry `cdk deploy`.
4. **IAM deployment permissions**. `cdk deploy` needs permissions to create
   IAM roles, Lambda functions, SQS queues, API Gateway resources, and
   CloudWatch alarms/log groups (typically via CloudFormation). Insufficient
   permissions usually surface as a `ROLLBACK_COMPLETE` stack event with an
   `AccessDenied` reason in the CloudFormation console — check there for
   the exact denied action.
