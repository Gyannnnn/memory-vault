# Phase 2 — AWS changes for Trash (M3)

Trash needs two changes in the console: **Object Lock** on the bucket, and an updated policy for the `memory-vault-app` user. They take about 15 minutes. Until you make them, Trash still works (move, restore, the 30-day countdown), but nothing is deleted from S3: items that are due wait in Trash, and the Trash page says why.

Use your admin sign-in for the console. Check that the region selector says **Asia Pacific (Mumbai) ap-south-1**. `BUCKET` below is the bucket name from `S3_BUCKET` in `apps/api/.env`.

**What deleting means after this:**

1. **Moving to Trash** hides an item. You can restore it from the Trash page for 30 days.
2. **After 30 days, or "Delete now"**, the app asks S3 to delete the original, its previews and its streaming versions. In a versioned bucket that only adds a _delete marker_: the file is still there as an older version.
3. **Those versions stay for 30 more days.** Object Lock stops anyone deleting them early, even with a leaked app key. Your existing `expire-old-versions` lifecycle rule then removes them. To get one back in that time, see [the runbook](../runbook-restore.md#3b-recover-a-file-deleted-from-trash).

So a file is gone for good about 60 days after you move it to Trash.

---

## 1. Turn on Object Lock

Open **https://s3.console.aws.amazon.com/s3/buckets/BUCKET?region=ap-south-1&tab=properties** (replace `BUCKET`).

1. Scroll to **Object Lock** → **Edit**.
2. **Enable**, then tick the acknowledgement. Object Lock can't be turned off again; that is the point of it.
3. **Default retention**: **Enable**.
   - Default retention mode: **Governance**.
   - Default retention period: **30** days.
4. **Save changes**.

From now on every new object version is locked for 30 days. Files already in the bucket are not locked retroactively; the policy below still stops the app from deleting any version of them.

Locked objects need a checksum on every upload. The app already sends one: the `upload with SHA-256 checksum` check in `pnpm aws:verify` confirms it.

> Test objects under `test/` are now kept for 30 days before the `expire-test-objects` rule can remove them. They are a few kilobytes.

## 2. Update the app's policy

Open **https://console.aws.amazon.com/iam/home#/users/details/memory-vault-app?section=permissions** → click the policy **memory-vault-app-access** → **Edit** → **JSON**. Replace everything with the policy below, replacing `BUCKET` (every occurrence) and `QUEUE_ARN` (once) as before → **Next** → **Save changes**.

What changes:

- The app may delete under `originals/` and `streams/`. Deleting only ever adds a delete marker.
- It may read the Object Lock settings, so `aws:verify` can check them.
- It is denied deleting a version (already denied), bypassing governance retention, and changing any lock.
- The old `NeverDeleteOriginals` statement is gone.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAttributes",
        "s3:GetObjectTagging",
        "s3:GetObjectRetention",
        "s3:PutObject",
        "s3:PutObjectTagging",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::BUCKET/users/*",
        "arn:aws:s3:::BUCKET/system/*",
        "arn:aws:s3:::BUCKET/test/*"
      ]
    },
    {
      "Sid": "DeleteAddsMarkersOnly",
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": [
        "arn:aws:s3:::BUCKET/users/*/inbox/*",
        "arn:aws:s3:::BUCKET/users/*/thumbs/*",
        "arn:aws:s3:::BUCKET/users/*/streams/*",
        "arn:aws:s3:::BUCKET/users/*/originals/*",
        "arn:aws:s3:::BUCKET/test/*"
      ]
    },
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::BUCKET"
    },
    {
      "Sid": "ReadBucketConfiguration",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketOwnershipControls",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketPolicy",
        "s3:GetBucketCORS",
        "s3:GetBucketNotification",
        "s3:GetIntelligentTieringConfiguration",
        "s3:GetBucketObjectLockConfiguration"
      ],
      "Resource": "arn:aws:s3:::BUCKET"
    },
    {
      "Sid": "ConsumeS3Events",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "QUEUE_ARN"
    },
    {
      "Sid": "NeverDestroyHistory",
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold",
        "s3:PutBucketObjectLockConfiguration",
        "s3:DeleteBucket",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"]
    }
  ]
}
```

## 3. Check

```bash
pnpm aws:verify
```

Every check should pass, including the new ones:

- `Object Lock on, governance mode, 30 days by default`
- `new objects are locked (governance) for 30 days`
- `app user can delete originals, which only adds a delete marker (Trash)`
- `app user cannot delete a version, even bypassing governance`

The old check `app user cannot delete originals` is replaced by the last two.

If items were waiting in Trash for this, they are deleted on the next nightly run (03:30 India time), or straight away if you choose **Delete now** on them again.
