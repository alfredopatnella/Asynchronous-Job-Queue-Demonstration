# Security

🌐 Language: **English** | [Español](es/security.md)

This is an educational sample, not a hardened production system. This
document is explicit about what is and is not covered, so it isn't mistaken
for a complete security posture.

## Trust boundaries

```text
Internet (untrusted)
   │  HTTPS (TLS, enforced by API Gateway)
   ▼
API Gateway  ──────────────────────────  AWS account boundary
   │  IAM-authorized Lambda invocation
   ▼
Producer Lambda
   │  IAM-authorized sqs:SendMessage
   ▼
SQS Job Queue  ──  SQS Dead-Letter Queue
   │  IAM-authorized poll/receive/delete (via event source mapping)
   ▼
Worker Lambda
```

Everything left of API Gateway is untrusted input. Everything to the right
of it runs under IAM roles scoped by this stack.

## IAM / least privilege

- The **producer** function's execution role is granted only
  `sqs:SendMessage` (plus the small set of read-only queue attribute calls
  the SDK needs to construct the request) on the **main queue's ARN**. It
  has no permissions on the DLQ and no permissions to receive or delete
  messages.
- The **worker** function's execution role is granted only the
  receive/delete/change-visibility permissions SQS event source mappings
  require, scoped to the main queue. It has no `sqs:SendMessage`
  permission anywhere — it cannot publish new jobs or write to the DLQ
  itself (the DLQ redrive is performed by the SQS service, not by IAM
  credentials the worker holds).
- Both roles are created by CDK's L2 constructs (`grantSendMessages`,
  `SqsEventSource`), which generate scoped resource-level policies rather
  than wildcard (`Resource: "*"`) statements.

## API exposure

- `POST /jobs` is a public, unauthenticated endpoint in this sample.
- Traffic is served over HTTPS by API Gateway; there is no plaintext HTTP
  path.
- There is no rate limiting, WAF, or usage plan configured. A real
  deployment behind this pattern should add at least one of: an API Gateway
  usage plan with throttling, AWS WAF, or authentication that lets you
  attribute and limit traffic per caller.

## Input validation

The producer performs minimal validation: it requires `reportType` and
`requestedBy` to be present, non-empty strings, and rejects bodies that
aren't valid JSON. It does not:

- Enforce an allow-list of valid `reportType` values.
- Limit string length.
- Sanitize `requestedBy` beyond type-checking.

Any of these would be reasonable additions before accepting untrusted
production traffic; they're deliberately minimal here so the validation
logic doesn't distract from the queueing lesson.

## Denial-of-service considerations

- **Producer side**: API Gateway has default account-level throttling, but
  nothing in this stack limits how many jobs a single caller can enqueue.
  A malicious or buggy caller could flood the queue.
- **Worker side**: `reservedConcurrentExecutions: 2` is actually a security
  asset here, not just a teaching device — it caps how much concurrent
  compute (and any downstream calls a real worker might make) a queue flood
  can trigger. The queue absorbs the excess instead of the worker fanning
  out unbounded concurrency.
- SQS itself scales to absorb very large backlogs, so a flood shows up as
  growing `ApproximateAgeOfOldestMessage` rather than a crash — that's the
  `job-queue-oldest-message-age` alarm's job to surface.

## Encryption

- **In transit**: API Gateway only serves HTTPS/TLS; the AWS SDK calls from
  both Lambdas to SQS use TLS by default.
- **At rest**: the queues in this sample use SQS's default (SSE-SQS,
  AWS-owned keys). For workloads with stricter compliance requirements,
  switch to SSE-KMS with a customer-managed key
  (`encryption: QueueEncryption.KMS` in CDK) so key usage is auditable and
  access can be restricted independently of queue permissions.

## Logging and sensitive data

- Both Lambdas log structured JSON including `jobId` and `reportType` to
  CloudWatch Logs. **Do not put PII, credentials, or other sensitive values
  into the job payload** (`reportType`, `requestedBy`, etc.) in a real
  deployment — anything on the queue can end up in CloudWatch Logs, and if
  a job repeatedly fails, in the DLQ, both of which are more broadly
  accessible than a normal application database.
- CloudWatch Logs access is controlled by IAM like any other AWS resource;
  this sample does not add extra restrictions beyond the account's default
  permissions. Restrict `logs:GetLogEvents`/`logs:FilterLogEvents` on these
  log groups to the people who actually need them, especially once real
  data flows through.

## Dead-letter queue considerations

The DLQ retains full copies of failed messages (14 days here) purely for
operator inspection. Because it holds the same payload as the main queue,
it inherits the same "don't put sensitive data in the payload" concern —
and arguably a stronger one, since DLQ contents are often reviewed manually
by whoever is debugging the failure, which is a broader audience than the
automated worker.

## Authentication

There is intentionally **no authentication** on `POST /jobs`. Adding
Cognito, IAM auth, or a custom authorizer was explicitly out of scope for
this sample (see the README) so the queueing pattern stays the focus. A
production deployment must add one of:

- An API Gateway authorizer (Cognito, IAM, or Lambda authorizer).
- A gateway/service in front of API Gateway that authenticates callers.

## Security controls implemented in this sample

- TLS-only API Gateway endpoint.
- Least-privilege IAM: producer can only send, worker can only
  receive/delete, neither has broad SQS permissions.
- No wildcard IAM resource policies.
- Reserved concurrency limiting blast radius / resource exhaustion.
- Structured logging without secrets baked into the sample payload.

## Security controls recommended for production

- API authentication/authorization (Cognito, IAM auth, or custom
  authorizer).
- Request throttling / usage plans / WAF.
- SSE-KMS encryption with a customer-managed key on both queues.
- Stricter input validation (allow-lists, length limits).
- Log field redaction or a policy against putting sensitive data in job
  payloads, enforced by review or automated scanning.
- Narrower CloudWatch Logs read access via IAM.
- A defined DLQ replay process with an audit trail.
- VPC-based network isolation if the worker calls internal/private
  downstream systems.
