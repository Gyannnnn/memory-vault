# Phase 0 — Laptop, phone and AWS setup

This guide gets everything ready for the first upload. Work through it top to bottom. It takes about 45 minutes. Every console link opens the exact page you need; always check that the region selector (top right of the AWS console) says **Asia Pacific (Mumbai) ap-south-1** on S3 and SQS pages.

Nothing here uses the existing `github-actions` IAM user or any admin access key. You create the resources by hand in the console, and the app gets its own narrowly-scoped user.

**Values you will collect** (keep this list open as you go):

| Value                  | Where it comes from | Example                                                                    |
| ---------------------- | ------------------- | -------------------------------------------------------------------------- |
| `ACCOUNT_ID`           | Step A1             | `123456789012`                                                             |
| `BUCKET`               | Step B1             | `memory-vault-originals-7f3k2a`                                            |
| `QUEUE_URL`            | Step D2             | `https://sqs.ap-south-1.amazonaws.com/123456789012/memory-vault-s3-events` |
| `QUEUE_ARN`            | Step D2             | `arn:aws:sqs:ap-south-1:123456789012:memory-vault-s3-events`               |
| Access key ID + secret | Step E3             | `AKIA…` / `…`                                                              |

---

## 0. Laptop and phone

### 0.1 Android platform-tools (adb)

Either install from apt (needs your password):

```bash
sudo apt install adb
```

or install Google's latest platform-tools without sudo:

```bash
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -fLO https://dl.google.com/android/repository/platform-tools-latest-linux.zip
unzip -q platform-tools-latest-linux.zip && rm platform-tools-latest-linux.zip
echo 'export PATH="$HOME/.local/opt/platform-tools:$PATH"' >> ~/.bashrc && source ~/.bashrc
adb version
```

### 0.2 USB debugging on the Galaxy S21 FE

1. **Settings → About phone → Software information** → tap **Build number** seven times (enter your PIN when asked). You'll see "Developer mode has been turned on".
2. **Settings → Developer options** (at the very bottom of Settings) → turn on **USB debugging**.
3. Unplug and re-plug the USB cable. On the phone, tap **Allow** on "Allow USB debugging?" and tick **Always allow from this computer**.
4. On the laptop:

   ```bash
   adb devices
   ```

   You should see `RZCX30G3QLK    device`. If it says `unauthorized`, unlock the phone and accept the prompt again.

Everything the tooling runs on the phone is read-only (`find`, `stat`, `sha256sum`, `pull`). The adb wrapper refuses any other command.

### 0.3 Docker

Start **Docker Desktop** and check:

```bash
docker info --format '{{.ServerVersion}}'
```

---

## A. Secure the AWS account

These protect the account the archive lives in. For a decades-long archive, the biggest real risks are losing access to the root login and the account being suspended over an unpaid bill.

### A1. Note your account ID

Open **https://console.aws.amazon.com/billing/home#/account**. Copy the 12-digit **Account ID** into your values list.

### A2. Turn on MFA for the root user

Sign in as the root user, then open **https://console.aws.amazon.com/iam/home#/security_credentials**.

1. Under **Multi-factor authentication (MFA)** click **Assign MFA device**.
2. Name it (e.g. `root-yubikey`), pick **Passkey or security key** (best) or **Authenticator app**, and follow the prompts.
3. Add a second MFA device (you can register up to 8), so losing one doesn't lock you out.

### A3. Alternate contacts and a backup payment method

- On **https://console.aws.amazon.com/billing/home#/account**, scroll to **Alternate contacts** → **Edit**. Add a trusted person for **Billing** and **Security**.
- On **https://console.aws.amazon.com/billing/home#/paymentmethods**, add a **second card**, so an expired card doesn't lead to suspension.

### A4. Monthly budget alert

Open **https://console.aws.amazon.com/costmanagement/home#/budgets/create**.

1. Choose **Use a template** → **Monthly cost budget**.
2. Name: `memory-vault-monthly`. Amount: `10` (USD). This is well above the expected ~$2–9/month.
3. Email recipients: your address. **Create budget**.

---

## B. Create the S3 bucket

### B1. Create it

Open **https://ap-south-1.console.aws.amazon.com/s3/bucket/create?region=ap-south-1**.

| Setting             | Value                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| AWS Region          | **Asia Pacific (Mumbai) ap-south-1**                                                                                  |
| Bucket type         | **General purpose**                                                                                                   |
| Bucket name         | `memory-vault-` + a random suffix, e.g. `memory-vault-originals-7f3k2a` (lowercase, globally unique; avoid your name) |
| Object Ownership    | **ACLs disabled (recommended)**                                                                                       |
| Block Public Access | **Block all public access** — all four boxes ticked                                                                   |
| Bucket Versioning   | **Enable**                                                                                                            |
| Default encryption  | **Server-side encryption with Amazon S3 managed keys (SSE-S3)**                                                       |
| Bucket Key          | leave as is                                                                                                           |
| Object Lock         | **Disable** (can be turned on later)                                                                                  |

Click **Create bucket** and add the name to your values list as `BUCKET`.

---

## C. Bucket settings

Open your bucket: `https://ap-south-1.console.aws.amazon.com/s3/buckets/BUCKET?region=ap-south-1` (replace `BUCKET`).

### C1. Lifecycle rules

Go to the **Management** tab → **Create lifecycle rule**. Create these four rules.

**Rule 1 — `cleanup-incomplete-uploads`**

- Scope: **Apply to all objects in the bucket** (tick the acknowledgement).
- Actions: tick **Delete expired object delete markers or incomplete multipart uploads**.
  - Tick **Delete incomplete multipart uploads** → Number of days: **7**.
  - Tick **Delete expired object delete markers**.

**Rule 2 — `expire-old-versions`**

- Scope: **Apply to all objects in the bucket**.
- Actions: tick **Permanently delete noncurrent versions of objects** → Days after objects become noncurrent: **30**. Leave "Number of newer versions to retain" empty.

This is the safety net for overwritten or deleted objects: they stay recoverable for 30 days.

**Rule 3 — `move-to-intelligent-tiering`**

- Scope: **Apply to all objects in the bucket**.
- Actions: tick **only** **Transition current versions of objects between storage classes** → Storage class: **Intelligent-Tiering** → Days after object creation: **0**.
- Acknowledge the small-objects notice.

> ⚠️ This rule must **not** have "Expire current versions of objects" or "Permanently delete noncurrent versions" ticked. On a whole-bucket rule, an expiry permanently deletes your files. `pnpm aws:verify` fails loudly if any rule outside `test/` expires current files.

The app already uploads straight into Intelligent-Tiering. This rule catches anything uploaded another way, such as drag-and-drop in the console.

**Rule 4 — `expire-test-objects`**

- Scope: **Limit the scope of this rule using one or more filters** → Prefix: `test/`.
- Actions:
  - tick **Expire current versions of objects** → **1** day.
  - tick **Permanently delete noncurrent versions of objects** → **1** day.

`pnpm aws:verify` and `pnpm test:aws` write only under `test/`.

> You don't need to configure "Intelligent-Tiering Archive configurations" under **Properties**. Without one, objects move automatically between the instant tiers only: Frequent → Infrequent (30 idle days) → Archive Instant (90 idle days). Any read brings an object straight back to Frequent, and every tier opens in milliseconds.

### C2. Bucket policy — refuse non-TLS connections

**Permissions** tab → **Bucket policy** → **Edit** → paste, replacing `BUCKET` in all four places → **Save changes**.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyOutdatedTls",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
      "Condition": { "NumericLessThan": { "s3:TlsVersion": "1.2" } }
    }
  ]
}
```

### C3. CORS — for direct browser uploads later

**Permissions** tab → **Cross-origin resource sharing (CORS)** → **Edit** → paste → **Save changes**. The web app's real domain gets added in Phase 2.

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedOrigins": ["http://localhost:3000"],
    "ExposeHeaders": ["ETag", "x-amz-checksum-sha256", "x-amz-version-id"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## D. SQS queue for S3 events

S3 tells the app about every new object (including files you drop into S3 directly) through this queue.

### D1. Dead-letter queue

Open **https://ap-south-1.console.aws.amazon.com/sqs/v3/home?region=ap-south-1#/create-queue**.

- Type: **Standard**. Name: `memory-vault-s3-events-dlq`.
- Configuration → Message retention period: **14 days**.
- Leave everything else as default → **Create queue**.

### D2. Main queue

Open the same link again.

| Setting                   | Value                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type                      | **Standard**                                                                                                                                            |
| Name                      | `memory-vault-s3-events`                                                                                                                                |
| Visibility timeout        | **15 minutes**                                                                                                                                          |
| Message retention period  | **14 days**                                                                                                                                             |
| Receive message wait time | **20 seconds**                                                                                                                                          |
| Encryption                | **Server-side encryption enabled**, key type **Amazon SQS key (SSE-SQS)**. Not KMS: S3 can't deliver to a queue encrypted with the AWS-managed KMS key. |
| Access policy             | choose **Advanced** and paste the JSON below, replacing `ACCOUNT_ID` (3×) and `BUCKET` (1×)                                                             |
| Dead-letter queue         | **Enabled** → choose `memory-vault-s3-events-dlq` → Maximum receives: **5**                                                                             |

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowVaultBucketToSend",
      "Effect": "Allow",
      "Principal": { "Service": "s3.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:ap-south-1:ACCOUNT_ID:memory-vault-s3-events",
      "Condition": {
        "ArnEquals": { "aws:SourceArn": "arn:aws:s3:::BUCKET" },
        "StringEquals": { "aws:SourceAccount": "ACCOUNT_ID" }
      }
    },
    {
      "Sid": "OwnerAccess",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::ACCOUNT_ID:root" },
      "Action": "sqs:*",
      "Resource": "arn:aws:sqs:ap-south-1:ACCOUNT_ID:memory-vault-s3-events"
    }
  ]
}
```

**Create queue**. On the queue's **Details** panel, copy the **URL** (`QUEUE_URL`) and the **ARN** (`QUEUE_ARN`).

### D3. Connect the bucket to the queue

Back on the bucket → **Properties** tab → **Event notifications** → **Create event notification**.

- Event name: `vault-object-created`.
- Prefix: `users/`. Suffix: empty.
- Event types: tick **All object create events**.
- Destination: **SQS queue** → **Choose from your SQS queues** → `memory-vault-s3-events`.
- **Save changes**. If it fails with "Unable to validate the following destination configurations", re-check the `ACCOUNT_ID`/`BUCKET` values in the queue's access policy (D2).

---

## E. IAM user for the app

This user can only read and write objects in your bucket and read from the queue. It can't delete originals, delete versions, change bucket settings, or touch anything else in the account.

### E1. Create the user

Open **https://console.aws.amazon.com/iam/home#/users/create**.

- User name: `memory-vault-app`.
- **Do not** tick "Provide user access to the AWS Management Console".
- Next → Permissions options: **Attach policies directly** → don't select any → Next → **Create user**.

### E2. Add the inline policy

Open **https://console.aws.amazon.com/iam/home#/users/details/memory-vault-app?section=permissions** → **Add permissions** → **Create inline policy** → **JSON** tab. Paste this, replacing `BUCKET` (every occurrence) and `ACCOUNT_ID` (1×) → Next → Policy name `memory-vault-app-access` → **Create policy**.

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
      "Sid": "DeleteOnlyScratchAndDerived",
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": [
        "arn:aws:s3:::BUCKET/users/*/inbox/*",
        "arn:aws:s3:::BUCKET/users/*/thumbs/*",
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
        "s3:GetIntelligentTieringConfiguration"
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
        "s3:DeleteBucket",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"]
    },
    {
      "Sid": "NeverDeleteOriginals",
      "Effect": "Deny",
      "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::BUCKET/users/*/originals/*"
    }
  ]
}
```

Replace `QUEUE_ARN` with the full ARN from D2 (e.g. `arn:aws:sqs:ap-south-1:123456789012:memory-vault-s3-events`).

### E3. Create the access key

Open **https://console.aws.amazon.com/iam/home#/users/details/memory-vault-app?section=security_credentials**.

1. **Access keys** → **Create access key**.
2. Use case: **Application running outside AWS** → Next.
3. Description tag: `laptop-dev` → **Create access key**.
4. Copy the **Access key** and the **Secret access key** now (the secret is shown only once). Don't download the CSV, or delete it right after pasting.

---

## F. Put the values into the app

1. Generate the local secrets and the `.env` files (safe to re-run; it never overwrites existing values):

   ```bash
   pnpm secrets:init
   ```

2. Open `apps/api/.env` and fill in:

   ```bash
   AWS_REGION=ap-south-1
   S3_BUCKET=BUCKET
   SQS_S3_EVENTS_QUEUE_URL=QUEUE_URL
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   ```

3. Check everything:

   ```bash
   pnpm aws:verify
   ```

   Each check prints ✓ or ✗, and every ✗ names the step in this guide to revisit. The final check writes a small object under `test/`, reads it back with its SHA-256 checksum, and waits for its event on the queue.

`.env` files are gitignored and never committed.

---

## Optional, off by default

| Option                   | What it does                                                                               | Cost                                              | How                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-region replication | A live copy in a second region (e.g. ap-southeast-1)                                       | Doubles storage, plus ~$0.09/GB one-time transfer | Create a second versioned bucket, then bucket → **Management** → **Replication rules**                                                   |
| Deep Archive Access tier | Originals idle for 180+ days drop to ~$0.002/GB-month, but need a ~12-hour restore to open | Saves ~$1/month at 350 GB                         | Bucket → **Properties** → **Intelligent-Tiering Archive configurations** → **Create configuration** → tick Deep Archive Access, 180 days |
| Object Lock              | Makes originals undeletable for a retention period, even by an admin                       | Free                                              | Bucket → **Properties** → **Object Lock** → **Edit** → Enable                                                                            |

These are discussed further in the Phase 1 feature suggestions.
