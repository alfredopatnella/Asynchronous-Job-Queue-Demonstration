#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsCdkLambdaSqsWorkerStack } from '../lib/aws-cdk-lambda-sqs-worker-stack';

const app = new cdk.App();
new AwsCdkLambdaSqsWorkerStack(app, 'AwsCdkLambdaSqsWorkerStack', {
  description: 'Educational asynchronous job queue: API Gateway -> Lambda -> SQS -> Lambda (aws-cdk-lambda-sqs-worker)',
});
