# Cost Considerations

🌐 Language: **English** | [Español](es/cost-considerations.md)

> AWS pricing changes over time and varies by region. The numbers below are
> for building intuition about **what drives cost** in this architecture,
> not a quote. Always check the current [AWS Pricing pages](https://aws.amazon.com/pricing/)
> for precise, up-to-date figures before estimating a real workload.

## Where cost comes from

| Service | What drives cost here |
|---|---|
| API Gateway | Number of API requests (`POST /jobs` calls), plus a small amount of data transfer. |
| Producer Lambda | Number of invocations (one per API request) × billed duration × configured memory. |
| SQS | Number of API calls the *system* makes against the queue — `SendMessage` (producer), plus `ReceiveMessage`/`DeleteMessage`/`ChangeMessageVisibility` (the event source mapping polling on the worker's behalf). |
| Worker Lambda | Number of invocations × billed duration × configured memory. Batching directly reduces invocation count. |
| CloudWatch Logs | Volume of log data ingested (bytes written by `console.log`) and how long it's retained. |
| CloudWatch Alarms | A small flat monthly cost per alarm (3 alarms in this stack) plus the metric evaluations, which are effectively free at this scale. |

## How batching affects invocation count

Without batching, N jobs would mean up to N separate worker invocations. With
`batchSize: 5`, the event source mapping can deliver up to 5 messages per
invocation when the queue has enough backlog, meaning as few as N/5 worker
invocations for the same N jobs. Since Lambda is billed per invocation and
per unit of duration, batching can meaningfully reduce cost at volume — the
trade-off (discussed in `docs/architecture.md`) is a larger failure blast
radius per invocation, mitigated here by partial batch responses.

## How logging affects cost

Every `console.log` call in the producer and worker becomes bytes stored in
CloudWatch Logs, billed both for ingestion and for storage over the
retention period. This sample logs one or two structured lines per job,
which is intentionally modest. A worker that logs verbose debug output on
every invocation, at high volume, in a busy production system, can turn
CloudWatch Logs into one of the largest line items in the bill — worth
watching if you extend this sample's logging.

## The queue smooths load, it doesn't make it free

SQS lets a burst of 10,000 incoming jobs be processed by 2 concurrent
workers over time instead of requiring 10,000 simultaneous Lambda
executions. That's valuable for reliability and for avoiding downstream
overload — but the *total* Lambda compute (duration × invocations) needed
to process all 10,000 jobs doesn't shrink because you added a queue; it's
roughly the same total work, just spread out. The queue changes the shape
of the cost curve (smoothed instead of spiky) and protects against
overwhelming downstream systems, but it isn't a cost-reduction technique on
its own.

## Example conceptual scenario

Say a demo or small workload processes **10,000 jobs/month**:

- **API Gateway**: 10,000 requests (plus whatever a real client's retry
  behavior adds).
- **Producer Lambda**: 10,000 invocations, each short (validate + one SQS
  call) — likely well under a second of billed duration each.
- **SQS**: 10,000 `SendMessage` calls, plus however many `ReceiveMessage`
  polling calls the event source mapping makes (this scales with polling
  frequency and queue activity, not 1:1 with job count) and 10,000
  `DeleteMessage` calls for the happy path.
- **Worker Lambda**: as few as 2,000 invocations (at a full batch of 5 per
  invocation) up to 10,000 (if jobs arrive too sparsely to batch), each
  running for roughly however long `processJob()` takes.
- **CloudWatch Logs**: a handful of short JSON log lines per job, times
  10,000.

At this volume, all of the above typically falls within (or very close to)
AWS's perpetual free tier for Lambda, API Gateway, and SQS in many accounts
— but free tier eligibility and limits also change, so don't treat that as
a guarantee. To turn this into an actual estimate, plug your own expected
job volume, average processing duration, and log verbosity into the
[AWS Pricing Calculator](https://calculator.aws) using current rates for
API Gateway, Lambda, SQS, and CloudWatch in your target region.
