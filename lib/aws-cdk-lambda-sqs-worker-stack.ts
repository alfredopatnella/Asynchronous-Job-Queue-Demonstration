import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';

// --- Demonstration-friendly configuration values -----------------------
// Kept as named constants (rather than scattered magic numbers) so the
// relationship between them is easy to read and to point at during a demo.

/** How long the worker Lambda is allowed to run before AWS times it out. */
const WORKER_TIMEOUT = cdk.Duration.seconds(15);

/**
 * How long SQS hides a message from other consumers after it is
 * received. This is deliberately much larger than WORKER_TIMEOUT.
 *
 * Lambda timeout != SQS visibility timeout -- they are two independent
 * settings. If the visibility timeout were shorter than (or too close
 * to) the time the worker needs to finish, SQS could make the message
 * visible again and hand it to a second invocation WHILE the first one
 * is still running, causing duplicate/overlapping processing. A common
 * rule of thumb is to size the visibility timeout at several multiples
 * of the function timeout; here 90s gives comfortable headroom over the
 * 15s worker timeout even accounting for retries within a batch.
 */
const QUEUE_VISIBILITY_TIMEOUT = cdk.Duration.seconds(90);

/** How many times SQS will present a message before routing it to the DLQ. */
const DLQ_MAX_RECEIVE_COUNT = 3;

/** How many messages the event source mapping delivers per invocation. */
const WORKER_BATCH_SIZE = 5;

/**
 * Caps how many worker invocations can run at the same time, regardless
 * of how many messages are queued. This is the mechanism that turns a
 * burst of incoming jobs into backpressure: SQS simply holds the extra
 * messages until a worker slot frees up, instead of every message
 * spawning its own concurrent Lambda execution.
 */
const WORKER_RESERVED_CONCURRENCY = 2;

export class AwsCdkLambdaSqsWorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Dead-letter queue -----------------------------------------------
    // Holds messages that failed processing DLQ_MAX_RECEIVE_COUNT times.
    // A DLQ does not fix or retry jobs on its own -- it isolates them so
    // an operator can inspect and, if appropriate, manually redrive them.
    const deadLetterQueue = new sqs.Queue(this, 'JobDeadLetterQueue', {
      queueName: 'job-queue-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // --- Main job queue ----------------------------------------------------
    const jobQueue = new sqs.Queue(this, 'JobQueue', {
      queueName: 'job-queue',
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: DLQ_MAX_RECEIVE_COUNT,
      },
    });

    // --- Producer Lambda -----------------------------------------------
    // Only responsible for validating the request and publishing to SQS.
    // It never generates a report itself.
    const producerFunction = new nodejs.NodejsFunction(this, 'ProducerFunction', {
      functionName: 'job-queue-producer',
      entry: path.join(__dirname, '../src/producer/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        QUEUE_URL: jobQueue.queueUrl,
      },
      logGroup: new logs.LogGroup(this, 'ProducerLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
    });

    // Least privilege: the producer may only send messages to this
    // specific queue -- it cannot read, delete, or manage the queue,
    // and cannot touch the DLQ at all.
    jobQueue.grantSendMessages(producerFunction);

    // --- Worker Lambda -----------------------------------------------
    // Consumes batches from the queue and reports partial batch failures.
    const workerFunction = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      functionName: 'job-queue-worker',
      entry: path.join(__dirname, '../src/worker/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: WORKER_TIMEOUT,
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64,
      // Deliberately small so a demo can visibly saturate it and watch
      // SQS queue depth grow as a stand-in for backpressure.
      reservedConcurrentExecutions: WORKER_RESERVED_CONCURRENCY,
      logGroup: new logs.LogGroup(this, 'WorkerLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
    });

    // The event source mapping is what actually polls SQS on Lambda's
    // behalf -- the application code never implements its own polling
    // loop. reportBatchItemFailures turns on the partial batch response
    // contract: only the messageIds the handler lists in
    // `batchItemFailures` are returned to the queue; the rest are
    // deleted as successful.
    workerFunction.addEventSource(
      new SqsEventSource(jobQueue, {
        batchSize: WORKER_BATCH_SIZE,
        reportBatchItemFailures: true,
      })
    );

    // The worker never sends messages -- it only consumes. Read/delete
    // permissions for the queue are granted implicitly by SqsEventSource;
    // no additional SQS permissions are attached here.

    // --- API Gateway ---------------------------------------------------
    const api = new apigateway.RestApi(this, 'JobApi', {
      restApiName: 'job-queue-api',
      description: 'Accepts asynchronous report-generation jobs.',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
    });

    const jobs = api.root.addResource('jobs');
    jobs.addMethod('POST', new apigateway.LambdaIntegration(producerFunction));

    // --- CloudWatch alarms -----------------------------------------------
    // These alarms have no destination configured (no SNS topic, no
    // email). In production you would route them to an operational
    // notification channel; here they exist purely so the ALARM state
    // itself is visible in the console during a demo.

    // Any message sitting in the DLQ means retries were exhausted for
    // that job and it needs human investigation.
    new cloudwatch.Alarm(this, 'DlqMessagesAlarm', {
      alarmName: 'job-queue-dlq-has-messages',
      alarmDescription:
        'One or more jobs exhausted their retries and landed in the dead-letter queue. Investigate and, if appropriate, redrive them.',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // A growing "age of oldest message" means jobs are waiting a long
    // time before being processed -- a sign the worker is falling
    // behind (throttled, erroring, or under-provisioned concurrency).
    new cloudwatch.Alarm(this, 'QueueAgeAlarm', {
      alarmName: 'job-queue-oldest-message-age',
      alarmDescription:
        'The oldest message in the main queue has been waiting too long. Check worker errors, throttling, and reserved concurrency.',
      metric: jobQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: QUEUE_VISIBILITY_TIMEOUT.toSeconds() * 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Worker function errors (unhandled exceptions outside the
    // per-record try/catch, e.g. a bad deployment) surfaced directly
    // from the Lambda Errors metric.
    new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
      alarmName: 'job-queue-worker-errors',
      alarmDescription: 'The worker Lambda is throwing errors outside of normal per-job failure handling.',
      metric: workerFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- Outputs ---------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      description: 'Base URL for the job API. POST {ApiUrl}jobs to submit a job.',
      value: api.url,
    });
    new cdk.CfnOutput(this, 'JobQueueUrl', {
      description: 'URL of the main job queue.',
      value: jobQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      description: 'URL of the dead-letter queue.',
      value: deadLetterQueue.queueUrl,
    });
  }
}
