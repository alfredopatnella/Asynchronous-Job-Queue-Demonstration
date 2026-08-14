import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsCdkLambdaSqsWorkerStack } from '../lib/aws-cdk-lambda-sqs-worker-stack';

function synthesize(): Template {
  const app = new cdk.App();
  const stack = new AwsCdkLambdaSqsWorkerStack(app, 'TestStack');
  return Template.fromStack(stack);
}

describe('AwsCdkLambdaSqsWorkerStack', () => {
  const template = synthesize();

  test('creates the main job queue and a dead-letter queue', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'job-queue',
      VisibilityTimeout: 90,
    });

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'job-queue-dlq',
    });
  });

  test('main queue redrives to the DLQ after the configured max receive count', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'job-queue',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  test('creates a producer Lambda and a worker Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'job-queue-producer',
      Handler: 'index.handler',
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'job-queue-worker',
      Handler: 'index.handler',
      Timeout: 15,
    });
  });

  test('worker Lambda has a small reserved concurrency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'job-queue-worker',
      ReservedConcurrentExecutions: 2,
    });
  });

  test('SQS event source mapping uses a small batch size with partial batch responses', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 5,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  test('creates a REST API with POST /jobs', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
  });

  test('creates CloudWatch alarms for the DLQ, queue age, and worker errors', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'job-queue-dlq-has-messages',
      MetricName: 'ApproximateNumberOfMessagesVisible',
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'job-queue-oldest-message-age',
      MetricName: 'ApproximateAgeOfOldestMessage',
    });
  });

  test('producer function is granted send-message permissions on the job queue only', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('^ProducerFunctionServiceRoleDefaultPolicy'),
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
            Effect: 'Allow',
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^JobQueue'), 'Arn'] },
          }),
        ]),
      }),
    });
  });

  test('outputs expose the API URL and queue URLs', () => {
    template.hasOutput('ApiUrl', {});
    template.hasOutput('JobQueueUrl', {});
    template.hasOutput('DeadLetterQueueUrl', {});
  });
});
