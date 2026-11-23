# Costs

Prices for **ap-south-1 (Mumbai)** from the AWS public price list, fetched 2026-11-23. They're also in `packages/shared/src/pricing.ts`, which the dry-run report uses.

## S3 Intelligent-Tiering (all objects)

| Tier               | When                             | $/GB-month | Access                    |
| ------------------ | -------------------------------- | ---------- | ------------------------- |
| Frequent           | New, or read in the last 30 days | 0.025      | Milliseconds              |
| Infrequent         | Not read for 30 days             | 0.0138     | Milliseconds              |
| Archive Instant    | Not read for 90 days             | 0.005      | Milliseconds              |
| Deep Archive (off) | Opt-in, after 180+ days          | 0.002      | Up to 12 hours to restore |

- Monitoring: $0.0025 per 1,000 objects per month (objects under 128 KB are not monitored and stay in Frequent).
- Requests: $0.005 per 1,000 PUTs, $0.0004 per 1,000 GETs.
- No retrieval fees in any Intelligent-Tiering tier.

## Estimates

| Library                                           | Month 1 | After 30 idle days | Steady state (90+ idle days) |
| ------------------------------------------------- | ------- | ------------------ | ---------------------------- |
| Laptop folder alone (77.5 GB unique, 14.5k files) | ~$1.97  | ~$1.10             | ~$0.42                       |
| 350 GB                                            | ~$8.80  | ~$4.90             | ~$1.80                       |
| 1 TB                                              | ~$25.60 | ~$14.10            | ~$5.20                       |

Previews add roughly 0.6 MB per photo (three WebP sizes), about 1–2% of the library, and tier down the same way.

## Other services

| Service                        | Expected cost     | Notes                                                       |
| ------------------------------ | ----------------- | ----------------------------------------------------------- |
| SQS                            | $0                | Free tier covers 1M requests/month                          |
| Data out to the internet       | $0 for normal use | 100 GB/month free; CloudFront (Phase 2) has 1 TB/month free |
| RDS (Phase 2)                  | ~$15–25/month     | db.t4g.micro + storage + backups; local Postgres until then |
| Video transcoding              | $0                | ffmpeg worker on your own machine or a spot instance        |
| Cross-region replication (off) | Doubles storage   | Plus ~$0.09/GB one-time transfer                            |

## Budget alert

The setup guide (§A4) creates a $10/month budget with email alerts.
