# Phase 5: Staging and Prod in the Cloud with Terraform

Goal for this phase: real environments on the internet. By the end, `terraform apply` builds a whole environment on AWS from nothing (network, a Kubernetes VM, a Postgres database, an S3 bucket, secrets, DNS), the VM installs Argo CD by itself, and Argo CD deploys your app from Git, with HTTPS, at `https://staging.<your domain>`. Prod is the same thing a second time, at `https://<your domain>`, and code only reaches it after you click **Approve** in GitHub. Then `terraform destroy` makes it all disappear, and the next `apply` brings it back exactly the same.

This is build order week 6. It's the first phase that costs real money, so the cost section comes before any code, and every section that creates something ends with how to delete it.

**Do it in two sittings.** Steps 0 to 14 write and merge everything and cost nothing except the domain. Steps 15 to 20 are when AWS starts charging (about 6 cents an hour per environment), so start those when you have a free afternoon, and finish with Step 20.

**Defaults I picked (all explained below):**
- **AWS, region `us-east-1`** (the cheapest region, and the one most tutorials and job postings assume).
- **k3s on one small VM per environment, not EKS.** EKS charges about $73/month for the control plane alone, before any machines. k3s is a complete, certified Kubernetes in one binary. It ships Traefik, the same ingress controller you already use on kind, so your chart works unchanged.
- **Managed Postgres (RDS)** in private subnets, **S3** for uploads, **Secrets Manager** for secrets, **External Secrets** to bring them into Kubernetes.
- **Redis stays inside the cluster.** It only holds job IDs waiting for a worker. A managed Redis (ElastiCache) would add about $12/month per environment for very little.
- **Images stay on GitHub Container Registry**, not ECR. Your `release.yml` already pushes public multi-arch images there for free, and CI needs no AWS credentials. Known gaps explains the ECR version.
- **A real domain in Route 53** plus **cert-manager and Let's Encrypt** for free HTTPS certificates.
- **No SSH.** You reach the VMs through AWS Systems Manager, so the firewall has nothing open except ports 80 and 443.
- **Terraform state in S3**, with Terraform's built-in lock file (no DynamoDB table needed anymore).

**What I tested and what I couldn't.** I wrote every file in this guide and checked it as far as I could without an AWS account. Terraform 1.16.7 with AWS provider 6.68.0: `terraform fmt` and `validate` are clean on all four roots. I then ran the real Terraform against **moto**, a local AWS emulator: the state bucket, the secrets and the full staging environment applied (25 resources), and so did `destroy` followed by a second `apply` (which proves the secret names can be reused). Prod applied too, except for its database, where moto has a bug with two RDS instances at once; prod uses the exact same modules, so that's moto, not the code. The budget is the one resource moto can't fake. I checked what landed: the database secret's JSON, the rendered first-boot script, the IMDS settings and the DNS record. On the Kubernetes side, `helm lint --strict` passes with all three values files, the local dev render is byte-for-byte identical to Phase 4 (your kind setup doesn't change), and a real Kubernetes 1.37 API server with the cert-manager 1.21.2, External Secrets 2.12.0 and Argo CD CRDs installed accepted the full staging and prod renders. I built External Secrets 2.12.0 from source and ran it against the fake AWS: it produced exactly the `flashcards-secrets` Secret the app expects, with a correct `DATABASE_URL`. I also confirmed with boto3 that the one-line app change below makes the S3 client use real AWS addresses. Workflows pass actionlint, scripts pass shellcheck. What I can't do from my sandbox: anything on real AWS (real VM boot, k3s, RDS, Let's Encrypt, the Systems Manager tunnel) or in your GitHub settings. So the first real `apply` happens on your side, and the troubleshooting table is how we'll debug it together.

## Cost first

Prices are AWS's on-demand prices for `us-east-1` as I know them. Check the AWS pricing pages if you want exact numbers, they change slowly.

**One environment while it's running:**

| Thing | Size | Per hour | Per month if you forget it |
|---|---|---|---|
| EC2 VM (k3s) | t4g.medium: 2 vCPU, 4 GB, ARM | ~$0.034 | ~$24.50 |
| VM disk | 30 GB gp3 | ~$0.003 | ~$2.40 |
| Public IPv4 address | 1 | $0.005 | ~$3.65 |
| RDS Postgres | db.t4g.micro, one zone | ~$0.016 | ~$11.70 |
| RDS disk | 20 GB gp3 | ~$0.003 | ~$2.30 |
| Secrets Manager | 1 secret (the DB) | ~$0.0006 | $0.40 |
| S3, DNS queries, data out | tiny | ~$0 | cents |
| **Total** | | **~$0.06/hour** | **~$45/month** |

Prod is the same again. **Both running: about $0.12/hour, so a 3-hour study session costs about 40 cents. Both forgotten for a month: about $90.** That's the whole reason for the `terraform destroy` habit.

**Always on, even with both environments destroyed:**
- The domain: a few dollars to about $15 per year, depending on the ending (Step 2).
- Route 53 hosted zone for the domain: $0.50/month.
- The two Anthropic key secrets: $0.80/month.
- The Terraform state bucket: a few cents.

So the idle floor is about $1.50/month.

**What I deliberately avoided:** EKS ($73/month control plane), NAT gateways (about $33/month each, plus data charges, and the #1 surprise on student AWS bills), load balancers (about $16/month each, k3s serves ports 80 and 443 straight from the VM), multi-zone RDS (double the price).

**Safety nets you'll set up in Step 6:** an AWS Budget that emails you at 50% and 100% of $20/month, and a forecast alert. It only warns, it never stops anything. New AWS accounts also come with some free credits; check **Billing and Cost Management > Credits** after you sign up.

## The big picture

```
Your Mac                                         GitHub: copaaglo/flashcards (main)
  terraform apply / destroy ──┐                     ▲  release.yml       writes the tag in values-staging.yaml
  aws ssm (tunnel, no SSH) ─┐ │                     │  promote-prod.yml  copies it to values-prod.yaml (after you approve)
                            │ │                     │
AWS us-east-1               │ ▼                     │ Argo CD polls main every ~60s
                            │ ┌ VPC flashcards-staging 10.10.0.0/16 ──────────────────────────┐
 Route 53                   │ │ public subnet                                                 │
 staging.<domain> ─────────────▶ EC2 "flashcards-staging" (Ubuntu + k3s)                       │
                            └───▶  Traefik :80 :443 ── cert-manager ── Let's Encrypt cert      │
                              │    Argo CD ── deploys the Helm chart from Git                  │
                              │    External Secrets ── reads Secrets Manager with the VM's role│
                              │    web, api, worker, redis   (namespace flashcards-staging)    │
                              │ private subnets (no internet route at all)                    │
                              │    RDS Postgres 17 ◀── port 5432, only from the VM            │
                              └───────────────────────────────────────────────────────────────┘
 S3: copaaglo-flashcards-staging-uploads          Secrets Manager: flashcards/staging/db
                                                                   flashcards/staging/anthropic-api-key
 Prod: the same again, VPC 10.20.0.0/16, answering on <domain>
```

Things to notice:
- **CI still never touches the cluster.** GitHub Actions builds images and commits tags, exactly like Phase 4. The only thing that changed is *where* Argo CD runs.
- **No AWS keys anywhere.** Not on your Mac (you log in with short-lived SSO credentials), not in GitHub, not in the cluster. The VM has an **IAM role**, and pods on it get temporary credentials from it.
- **No password typed by a human.** Terraform generates the database password, stores it in Secrets Manager, and External Secrets builds `DATABASE_URL` from it.

### Terraform in five minutes

Terraform is the standard tool for **Infrastructure as Code**: you describe the infrastructure you want in `.tf` files, and Terraform makes AWS match them. It's to AWS what your Helm chart plus Argo CD is to Kubernetes, with one big difference: Terraform only acts when you run it.

- **Provider**: a plugin that talks to one API (AWS here). Pinned to a version like everything else.
- **Resource**: one thing to create, like `aws_instance` or `aws_s3_bucket`.
- **Data source**: something to *look up* that Terraform doesn't own, like your domain's hosted zone or the latest Ubuntu image ID.
- **Module**: a folder of `.tf` files with inputs (`variable`) and outputs (`output`), used like a function. Staging and prod call the same modules with different inputs, which is exactly the values-file idea from Helm.
- **Root**: a folder you run `terraform` in. Each root has its own state.
- **State**: Terraform's memory of what it created, mapping `aws_instance.cluster` to the real `i-0abc123`. Without it, Terraform can't update or delete anything. That's why state goes in an S3 bucket instead of your laptop, and why it's locked while someone is running `apply`.
- **The loop**: `init` (download providers, connect to the state), `plan` (show what would change, change nothing), `apply` (show the plan again, ask, do it), `destroy` (delete everything in this root).

**Reading `plan` is the #1 Terraform skill**, the same way reading `helm template` was for Helm. `+` create, `~` update in place, `-/+` destroy and recreate (careful!), `-` destroy. A real team never applies a plan nobody read.

This repo gets four roots:

| Root | What's in it | State lives | Lifetime |
|---|---|---|---|
| `infra/terraform/bootstrap` | The state bucket | Your Mac (gitignored) | Forever, apply once |
| `infra/terraform/global` | Budget alarm, Anthropic key secrets | S3 | Forever, apply once |
| `infra/terraform/envs/staging` | Staging: VPC, VM, RDS, bucket, DNS | S3 | Apply when studying, destroy after |
| `infra/terraform/envs/prod` | Prod: same modules, different inputs | S3 | Apply when studying, destroy after |

**Why not one root with everything?** Blast radius. `terraform destroy` in `envs/staging` can't possibly touch prod, the budget, or the state bucket, because they aren't in its state. Real companies split roots by environment and by how often things change, for exactly this reason.

## Step 0: Prereqs

1. Phase 4 done: a merge to `main` deploys staging on kind by itself, and the smoke test passes. If you're still finishing Phase 4 Step 11, finish that first.
2. The tools. Terraform moved to HashiCorp's own Homebrew tap after its license change in 2023, so it's a two-word install:
   ```bash
   brew tap hashicorp/tap
   brew install hashicorp/tap/terraform awscli
   brew install --cask session-manager-plugin
   ```
   ```bash
   terraform version
   aws --version
   session-manager-plugin --version
   ```
   You want Terraform 1.10 or newer and AWS CLI version 2. (You'll hear about **OpenTofu**, a community fork of Terraform with the same language. Everything here works with it too, but Terraform is still what most job postings say.)
3. Docker Desktop running (only for the unit tests in Step 11).
4. A credit card for the AWS account and the domain.

## Step 1: An AWS account you can't hurt yourself with

If you already have an AWS account, still do 1b to 1d.

### 1a. Create the account

Sign up at https://aws.amazon.com. You need a credit card and a phone number. If it asks you to pick a plan, the free plan with credits is fine to start. If something later in this guide says it isn't available on your plan (buying a domain can be one of them), that's when you upgrade; leftover credits still apply.

### 1b. Lock the root user

The email and password you signed up with is the **root user**. It can do anything, including close the account, and can't be limited. Real companies lock it in a safe and never use it.

1. Top right, your account name > **Security credentials** > **Assign MFA device**. Use an authenticator app or a passkey.
2. Never create access keys for root. If that page shows any, delete them.

### 1c. Your everyday admin login (IAM Identity Center)

You'll use a separate admin user that logs in through your browser and hands the terminal **short-lived** credentials. No long-lived access keys sitting in `~/.aws/credentials` waiting to be leaked. This is how companies do it now, and "I never had AWS access keys on my laptop" is a nice thing to say in an interview.

In the AWS console, make sure the region selector (top right) says **N. Virginia (us-east-1)**, then:
1. Search for **IAM Identity Center** > **Enable**. If it asks, pick the organization option.
2. **Users** > **Add user**. Username like `conrado`, your email. Finish. You'll get an invitation email: accept it, set a password, and set up MFA when asked.
3. **Permission sets** > **Create permission set** > **Predefined permission set** > **AdministratorAccess** > Next until **Create**.
4. **AWS accounts** > tick your account > **Assign users or groups** > your user > Next > **AdministratorAccess** > Next > **Submit**.
5. **Settings** (or the dashboard) shows your **AWS access portal URL**, like `https://d-1234567890.awsapps.com/start`. Copy it.

### 1d. Log in from the terminal

```bash
aws configure sso
```

It asks a few things. Answer:
- **SSO session name**: `flashcards`
- **SSO start URL**: the portal URL you just copied
- **SSO region**: `us-east-1`
- **SSO registration scopes**: just press Enter

Your browser opens. Allow it. Back in the terminal, pick your account and **AdministratorAccess**, then:
- **Default client Region**: `us-east-1`
- **CLI default output format**: `json`
- **Profile name**: `flashcards`

Make it the default for this and every new terminal:

```bash
echo 'export AWS_PROFILE=flashcards' >> ~/.zshrc
export AWS_PROFILE=flashcards
aws sts get-caller-identity
```

You should see your account number and an ARN with `AWSReservedSSO_AdministratorAccess` in it. When the login expires (after some hours), commands fail with an expired-token error, and you run:

```bash
aws sso login
```

> ⚠️ **Security flag:** an admin role for yourself is fine on a personal account. At a company, Terraform usually runs as a narrower role, and humans get read-only by default and request admin for a limited time.

## Step 2: A domain

HTTPS certificates are issued for domain names, and the plan says "HTTPS on a real domain", so you need one. Buying it in Route 53 is the simplest path, because AWS then creates the DNS zone for you and Terraform can find it.

1. AWS console > **Route 53** > **Registered domains** > **Register domains**.
2. Search for a name. The price is per year and depends on the ending: some endings (like `.click` or `.link`) are a few dollars, `.com` is about $15. Any ending works for this project.
3. Buy it. You'll get an email asking you to verify your contact address: click it, or the domain gets suspended after 15 days.
4. Registration takes from a few minutes to a few hours. Route 53 creates a **hosted zone** for it automatically (that's the $0.50/month).
5. On the domain's page you can turn **auto-renew** off if you don't want it renewed next year.

> Already own a domain somewhere else? In Route 53, **Hosted zones > Create hosted zone** with your domain name, then set the four `NS` values it shows as the domain's nameservers at your registrar.

Now save the domain in a variable that later steps use. ⚠️ **Replace `yourdomain.click` with the domain you actually bought** before pressing Enter:

```bash
echo 'export FLASHCARDS_DOMAIN=yourdomain.click' >> ~/.zshrc
```

Then load it and check AWS knows the zone:

```bash
source ~/.zshrc
echo "$FLASHCARDS_DOMAIN"
aws route53 list-hosted-zones-by-name --dns-name "$FLASHCARDS_DOMAIN" --max-items 1 --query 'HostedZones[0].Name' --output text
```

The last line must print **your domain with a dot at the end**, like `yourdomain.click.`. If it prints `None` or a different name, the domain isn't registered yet, or the variable is wrong: fix the line at the end of `~/.zshrc` in an editor and run `source ~/.zshrc` again.

## Step 3: Branch

```bash
cd ~/flashcards
git switch main
git pull
git switch -c phase5-cloud
```

Check your prompt says `phase5-cloud` before you commit anything in this phase.

## Step 4: Keep state and personal values out of Git

State files contain secrets (the database password ends up in there), and `.tfvars` files are where your email goes. This block only appends if the lines aren't there yet, so it's **safe to paste twice**:

```bash
grep -q '^\*\.tfstate$' .gitignore || cat >> .gitignore <<'EOF'

# Terraform: provider downloads, state (contains secrets) and variable files (personal values)
.terraform/
*.tfstate
*.tfstate.*
*.tfvars
crash.log
EOF
tail -8 .gitignore
```

You *will* commit the `.terraform.lock.hcl` files that `terraform init` creates. They pin the exact provider versions and checksums, like `package-lock.json` does for npm.

## Step 5: The state bucket (bootstrap)

The chicken-and-egg problem: Terraform's state should live in S3, but the S3 bucket has to be created by something first. The usual answer is a tiny "bootstrap" root that keeps its own state on your Mac and creates nothing but the bucket.

```bash
mkdir -p infra/terraform/bootstrap infra/terraform/global infra/terraform/modules/vpc infra/terraform/modules/cluster infra/terraform/modules/database infra/terraform/modules/bucket infra/terraform/envs/staging infra/terraform/envs/prod
```

`infra/terraform/bootstrap/main.tf`:

```bash
cat > infra/terraform/bootstrap/main.tf <<'EOF'
# Creates the S3 bucket that stores the state of every other Terraform root in this repo.
#
# This root is the exception: its own state stays on your Mac (terraform.tfstate in this
# folder, gitignored), because a bucket can't hold the state of its own creation.
# Apply it once and leave it. It costs a few cents a month.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "flashcards"
      ManagedBy = "terraform"
      Root      = "bootstrap"
    }
  }
}

resource "aws_s3_bucket" "tfstate" {
  # Bucket names are global across every AWS account, so it starts with your GitHub name
  bucket = "copaaglo-flashcards-tfstate"

  # Terraform refuses to delete this bucket, even with "terraform destroy".
  # Losing state means Terraform forgets what it created, and you clean up by hand.
  lifecycle {
    prevent_destroy = true
  }
}

# Every write keeps the previous version, so a corrupted or deleted state file can be restored
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

# State files contain secrets (like the database password), so nothing here is ever public
resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Old versions are only for recovering from mistakes, so they don't need to live forever
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}
EOF
```

- **The bucket name** has to be unique across all of AWS, worldwide. Prefixing it with your GitHub name makes a collision very unlikely without putting your AWS account number in a public repo.
- **`prevent_destroy`** makes Terraform refuse to delete it. It's your safety catch on the one thing you never want to lose.
- **Versioning** means a bad write (or a mistaken delete) of a state file can be undone by restoring the previous version.
- **Public access block**: four switches that make it impossible to make anything in this bucket public, even by accident later.
- **`default_tags`** puts the same tags on everything this root creates, so you can filter by `Project = flashcards` in the console and in the bill.

Run it. `-chdir` tells Terraform which root to work in, so you can stay in `~/flashcards` the whole phase:

```bash
terraform -chdir=infra/terraform/bootstrap init
terraform -chdir=infra/terraform/bootstrap plan
```

Read the plan: `Plan: 4 to add, 0 to change, 0 to destroy.` Four resources, all `+`. Then:

```bash
terraform -chdir=infra/terraform/bootstrap apply
```

It shows the plan again and waits for you to type `yes`. That pause is on purpose: `apply` always shows you what it's about to do. Expected ending:

```
Apply complete! Resources: 4 added, 0 changed, 0 destroyed.

Outputs:

state_bucket = "copaaglo-flashcards-tfstate"
```

There's now an `infra/terraform/bootstrap/terraform.tfstate` on your Mac. Git ignores it (Step 4). Don't delete it: it's how this root remembers the bucket. If you ever lose it, nothing breaks, you'd just have to `terraform import` the bucket to manage it again.

## Step 6: Budget alarm and the Anthropic key secrets (global)

`infra/terraform/global/main.tf`:

```bash
cat > infra/terraform/global/main.tf <<'EOF'
# Account-wide things that outlive any one environment: a budget alarm, and the secret
# "boxes" for the Anthropic API keys. Apply once, rarely touch, don't destroy.
# Costs about $0.80/month (two secrets). The budget itself is free.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68.0"
    }
  }

  # State lives in the bucket from the bootstrap root. use_lockfile makes Terraform
  # write a lock file next to it while it works, so two applies can never run at once.
  backend "s3" {
    bucket       = "copaaglo-flashcards-tfstate"
    key          = "global/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "flashcards"
      ManagedBy = "terraform"
      Root      = "global"
    }
  }
}

variable "alert_email" {
  description = "Where AWS sends budget alerts. Set it in terraform.tfvars (gitignored)."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly spend you expect. Alerts fire at 50% and 100% of it."
  type        = number
  default     = 20
}

# An email when this month's bill passes half the budget, all of it, or is forecast to.
# It only warns, it never stops anything. terraform destroy is still your job.
resource "aws_budgets_budget" "monthly" {
  name         = "flashcards-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# One Anthropic key per environment. Terraform makes the empty secret, you put the value
# in with the AWS CLI (guide Step 6), so the key is never in Git or in Terraform state.
# These live here and not in envs/ so the value survives terraform destroy of an environment.
resource "aws_secretsmanager_secret" "anthropic_api_key" {
  for_each = toset(["staging", "prod"])

  name        = "flashcards/${each.key}/anthropic-api-key"
  description = "Anthropic API key for the flashcards worker in ${each.key}"
}

output "anthropic_secret_names" {
  value = [for s in aws_secretsmanager_secret.anthropic_api_key : s.name]
}
EOF
```

- **`backend "s3"`**: this root keeps its state in the bucket from Step 5. **`use_lockfile = true`** makes Terraform write a small `.tflock` file next to the state while it runs, so two `apply`s can never run at the same time and corrupt it. (Older guides use a DynamoDB table for this. Since Terraform 1.10, S3 can do it alone.)
- **The budget** sends email at 50% of the monthly amount, at 100%, and when AWS *forecasts* you'll pass 100%. AWS updates the numbers a few times a day, so it's a smoke alarm, not a circuit breaker.
- **The secrets are empty boxes.** Terraform creates `flashcards/staging/anthropic-api-key` and `flashcards/prod/anthropic-api-key` but never sees the value. You put the value in with the AWS CLI. If Terraform set the value, it would be stored in the Terraform state, and anyone who can read the state could read your key.
- **Why here and not in `envs/`?** So the key survives `terraform destroy` of an environment. Otherwise you'd have to put it back after every `apply`.
- **`for_each`** makes one resource per item in the set, named `aws_secretsmanager_secret.anthropic_api_key["staging"]` and `["prod"]` in the state.

Your email goes in a `terraform.tfvars` file, which Terraform reads automatically and Git ignores. ⚠️ **Replace `you@example.com` with your real email** before pressing Enter:

```bash
echo 'alert_email = "you@example.com"' > infra/terraform/global/terraform.tfvars
cat infra/terraform/global/terraform.tfvars
```

```bash
terraform -chdir=infra/terraform/global init
terraform -chdir=infra/terraform/global apply
```

The plan should say `3 to add` (one budget, two secrets). Type `yes`.

Now put your Anthropic key into both secrets, straight out of `.env` so it never shows up in your shell history (same trick as Phase 3):

```bash
aws secretsmanager put-secret-value --secret-id flashcards/staging/anthropic-api-key --secret-string "$(grep '^ANTHROPIC_API_KEY=' .env | cut -d= -f2-)"
aws secretsmanager put-secret-value --secret-id flashcards/prod/anthropic-api-key --secret-string "$(grep '^ANTHROPIC_API_KEY=' .env | cut -d= -f2-)"
```

Each prints the secret's ARN and a `VersionId`. Check without printing the value:

```bash
aws secretsmanager describe-secret --secret-id flashcards/staging/anthropic-api-key --query '{name: Name, versions: VersionIdsToStages}'
```

You want one version marked `AWSCURRENT`.

**Same key for both, for now.** At a company, each environment gets its own key (in the Anthropic Console you can make a second key, and even a separate workspace with its own spend limit), so a leaked staging key can be revoked without touching prod, and you can see what each environment spends. To switch later, run the prod `put-secret-value` again with the new key.

## Step 7: The modules

Four modules, one file each. (Bigger modules usually split into `main.tf`, `variables.tf` and `outputs.tf`. One file is easier to paste and read while you learn; Terraform reads every `.tf` file in the folder either way.)

### 7a. The network (vpc)

`infra/terraform/modules/vpc/main.tf`:

```bash
cat > infra/terraform/modules/vpc/main.tf <<'EOF'
# A private network for one environment: two public subnets (the cluster VM lives in one)
# and two private subnets (the database, which never gets a public address).
# No NAT gateway on purpose: it costs about $33/month, and nothing in the private
# subnets needs to reach the internet.

variable "name" {
  description = "Prefix for resource names, like flashcards-staging"
  type        = string
}

variable "cidr" {
  description = "Address range for the whole VPC, like 10.10.0.0/16"
  type        = string
}

# Two availability zones (separate data centers). RDS requires subnets in at least two.
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block = var.cidr
  # Lets things inside the VPC resolve AWS hostnames, like the database endpoint
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = var.name
  }
}

# The VPC's door to the internet
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = var.name
  }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  # 10.10.0.0/24 and 10.10.1.0/24 for a 10.10.0.0/16 VPC
  cidr_block = cidrsubnet(var.cidr, 8, count.index)
  # Machines here get a public IP, which is what makes the subnet "public" in practice
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name}-public-${local.azs[count.index]}"
  }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  # 10.10.10.0/24 and 10.10.11.0/24
  cidr_block = cidrsubnet(var.cidr, 8, count.index + 10)

  tags = {
    Name = "${var.name}-private-${local.azs[count.index]}"
  }
}

# Public subnets send internet traffic through the internet gateway.
# Private subnets keep the VPC's default route table, which only knows the VPC itself.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "${var.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
EOF
```

- **VPC**: your own private network inside AWS. Nothing gets in or out unless you add a way.
- **Subnets** split it up, and each lives in one **availability zone** (a separate data center in the region). RDS insists on subnets in two zones, even for a single database, so it can move there if needed.
- **Public vs private** is just routing: the public route table sends `0.0.0.0/0` (everything) to the **internet gateway**. The private subnets keep the default table, which only knows the VPC. So the database has no route to or from the internet at all, no matter what anyone types into a firewall rule.
- **`cidrsubnet(var.cidr, 8, n)`** carves `/24` blocks out of the `/16`, so you never calculate IP ranges by hand. Staging is `10.10.0.0/16` and prod `10.20.0.0/16`: different on purpose, so they could be connected later without clashing.
- **No NAT gateway.** A NAT gateway lets private machines reach the internet. Our private subnets only hold RDS, which doesn't need to. Leaving it out saves about $33/month per environment. Lots of real AWS bills have a forgotten NAT gateway on them.

### 7b. The uploads bucket

`infra/terraform/modules/bucket/main.tf`:

```bash
cat > infra/terraform/modules/bucket/main.tf <<'EOF'
# The S3 bucket for uploaded lecture files.

variable "name" {
  description = "Globally unique bucket name"
  type        = string
}

variable "force_destroy" {
  description = "Let terraform destroy delete the bucket even when it still has files in it"
  type        = bool
  default     = false
}

variable "expire_after_days" {
  description = "Delete uploads after this many days. The cards are in Postgres, the PDF is only needed while the job runs."
  type        = number
  default     = 30
}

resource "aws_s3_bucket" "this" {
  bucket        = var.name
  force_destroy = var.force_destroy
}

# Uploads are private. The app reads and writes them with its IAM role, nobody gets a public link.
resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Less storage to pay for, and less student data sitting around
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = var.expire_after_days
    }
  }
}

output "name" {
  value = aws_s3_bucket.this.bucket
}

output "arn" {
  value = aws_s3_bucket.this.arn
}
EOF
```

- The bucket is private. The app reaches it with the VM's IAM role, never with a public URL.
- **The lifecycle rule** deletes uploads after 30 days. Once a job is done, the cards live in Postgres, so the PDF is just storage cost and student data you don't need. "We keep personal data only as long as we need it" is also a privacy requirement at most companies.
- **`force_destroy`** is a module input, and the environments turn it on so `terraform destroy` works even with uploads inside. For a real prod bucket you'd leave it off.

### 7c. The cluster

`infra/terraform/modules/cluster/main.tf`:

```bash
cat > infra/terraform/modules/cluster/main.tf <<'EOF'
# One VM running k3s (a small, complete Kubernetes), plus everything it needs:
# a firewall, an IAM role instead of access keys, and a DNS name.
# On first boot the VM installs k3s and runs deploy/cloud/bootstrap.sh from the repo,
# which installs Argo CD. From there Argo CD deploys the app from Git.

variable "name" {
  description = "Prefix for resource names, like flashcards-staging"
  type        = string
}

variable "environment" {
  description = "staging or prod. Picks deploy/argocd/flashcards-<environment>.yaml."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_id" {
  description = "A public subnet, so the VM can be reached on ports 80 and 443"
  type        = string
}

variable "instance_type" {
  description = "t4g = ARM (Graviton), cheaper than x86 for the same size. medium = 2 vCPU, 4 GB."
  type        = string
  default     = "t4g.medium"
}

variable "zone_name" {
  description = "Your Route 53 hosted zone (the domain you bought), like example.com"
  type        = string
}

variable "hostname" {
  description = "Full name the app answers on, like staging.example.com"
  type        = string
}

variable "uploads_bucket_arn" {
  type = string
}

variable "repo_url" {
  description = "Public Git repo the VM clones to run the bootstrap script"
  type        = string
  default     = "https://github.com/copaaglo/flashcards.git"
}

variable "k3s_version" {
  type    = string
  default = "v1.37.1+k3s1"
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

# Canonical publishes the latest Ubuntu 24.04 image ID here, so we never hardcode an AMI
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

# --- Firewall ---------------------------------------------------------------

resource "aws_security_group" "cluster" {
  name        = "${var.name}-cluster"
  description = "k3s VM: web traffic in, anything out"
  vpc_id      = var.vpc_id

  # HTTP is needed for Let's Encrypt to check you own the domain, HTTPS is the app
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # No SSH (22) and no Kubernetes API (6443) from the internet. You get in through
  # AWS Systems Manager instead, which needs no open port at all.

  egress {
    description = "Anything out: GitHub, GHCR, Anthropic, AWS APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name}-cluster"
  }
}

# --- IAM: what the VM (and so the pods on it) may do in AWS -----------------

resource "aws_iam_role" "cluster" {
  name = "${var.name}-cluster"

  # Only EC2 can use this role
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# AWS's managed policy for Systems Manager: lets you open a shell or a tunnel to the VM
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Exactly what the app needs, nothing more
resource "aws_iam_role_policy" "app" {
  name = "app"
  role = aws_iam_role.cluster.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadThisEnvironmentsSecrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        # Only flashcards/staging/* for staging, so staging can never read prod's secrets
        Resource = "arn:aws:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:flashcards/${var.environment}/*"
      },
      {
        # The api calls head_bucket on startup, which needs ListBucket
        Sid      = "FindTheUploadsBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = var.uploads_bucket_arn
      },
      {
        Sid      = "ReadAndWriteUploads"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${var.uploads_bucket_arn}/*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "cluster" {
  name = "${var.name}-cluster"
  role = aws_iam_role.cluster.name
}

# --- The VM -----------------------------------------------------------------

resource "aws_instance" "cluster" {
  ami                    = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.cluster.id]
  iam_instance_profile   = aws_iam_instance_profile.cluster.name

  # The first-boot script. Changing it replaces the VM: it's cattle, not a pet.
  user_data = templatefile("${path.module}/cloud-init.sh.tftpl", {
    k3s_version = var.k3s_version
    repo_url    = var.repo_url
    environment = var.environment
  })
  user_data_replace_on_change = true

  metadata_options {
    # IMDSv2 only: the metadata endpoint needs a session token, which blocks a classic
    # SSRF attack that stole credentials from IMDSv1 (the 2019 Capital One breach)
    http_tokens = "required"
    # 2 hops so pods (one network hop further than the VM) can get the role's credentials
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  lifecycle {
    # A newer Ubuntu image shouldn't replace a running cluster on the next apply.
    # You get the new image the next time you destroy and apply.
    ignore_changes = [ami]
  }

  tags = {
    Name = var.name
  }
}

# --- DNS --------------------------------------------------------------------

data "aws_route53_zone" "this" {
  name = var.zone_name
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.hostname
  type    = "A"
  # Short TTL: the IP changes every time the VM is recreated
  ttl     = 60
  records = [aws_instance.cluster.public_ip]
}

output "instance_id" {
  value = aws_instance.cluster.id
}

output "public_ip" {
  value = aws_instance.cluster.public_ip
}

output "security_group_id" {
  value = aws_security_group.cluster.id
}

output "url" {
  value = "https://${var.hostname}"
}
EOF
```

`infra/terraform/modules/cluster/cloud-init.sh.tftpl`:

```bash
cat > infra/terraform/modules/cluster/cloud-init.sh.tftpl <<'EOF'
#!/bin/bash
# Runs once, as root, on the VM's first boot. Terraform fills in the values in curly braces.
# Output goes to /var/log/cloud-init-output.log on the VM.
set -euo pipefail

# k3s: a whole Kubernetes in one binary, pinned to a version like everything else.
# --secrets-encryption encrypts Secrets in k3s's database on disk.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" sh -s - server --secrets-encryption

# The rest of the setup lives in Git, where you can read and review it
git clone --depth 1 "${repo_url}" /opt/flashcards
bash /opt/flashcards/deploy/cloud/bootstrap.sh "${environment}"
EOF
```

This is the big one. Block by block:

**The AMI from SSM.** An AMI is the disk image a VM boots from. AMI IDs are different in every region and change with every Ubuntu update, so hardcoding one goes stale. Canonical publishes the current Ubuntu 24.04 ID at a well-known Parameter Store path, and the data source reads it. `t4g` machines are ARM (AWS Graviton), so it's the `arm64` image. Your `release.yml` already builds ARM images (for your Mac), so the same images run here.

**The security group** is the VM's firewall. In: 80 and 443 from anywhere. Out: anything. Notice what's *not* there: port 22 (SSH) and 6443 (the Kubernetes API). Open SSH ports get scanned by bots within minutes of a VM appearing. You'll get in through **Systems Manager**, where the VM's agent calls out to AWS and AWS checks your IAM login, so there's nothing open to attack.

**IAM role and instance profile.** This is how the VM, and anything running on it, gets AWS permissions without access keys. The role has:
- `AmazonSSMManagedInstanceCore`, AWS's managed policy that lets you open a shell or a tunnel through Systems Manager.
- An inline policy that's exactly what the app needs: read secrets under `flashcards/<this environment>/` and nothing else, list the uploads bucket (the api's startup `head_bucket` needs it), and read and write objects in it. Staging can't read prod's secrets, because the ARN pattern says `flashcards/staging/*`. You'll prove that in Step 19b.

The **instance profile** is the small wrapper EC2 needs to attach a role to a VM. It's an AWS quirk, every EC2 role has one.

**The instance.**
- **`user_data`** is a script cloud-init runs as root on the first boot. `templatefile` fills in the k3s version, repo URL and environment. The script installs k3s, clones your repo, and runs `deploy/cloud/bootstrap.sh` (Step 9), which installs everything else. Most of the setup lives in Git as a normal script you can read and review, not hidden in Terraform.
- **`user_data_replace_on_change = true`**: if the first-boot script changes, Terraform replaces the VM instead of pretending the change applied (user data only runs once). That's the **"cattle, not pets"** idea: you don't fix servers by hand, you replace them from code. Everything that matters lives in Git, RDS, S3 or Secrets Manager, so losing the VM loses nothing.
- **`metadata_options`**: every EC2 VM has a metadata endpoint (`169.254.169.254`) that hands out the role's temporary credentials. `http_tokens = "required"` forces IMDSv2, which needs a session token and blocks the SSRF attack used in the 2019 Capital One breach. `http_put_response_hop_limit = 2` lets pods reach it, because a pod is one network hop further away than the VM itself. With the default of 1, External Secrets and the app would fail with "no credentials".
- **`ignore_changes = [ami]`**: Canonical publishes new Ubuntu images often. Without this, every new image would make the next `apply` replace your running VM. You pick up new images when you destroy and apply anyway.
- **Encrypted gp3 root disk.** Encryption at rest is a checkbox on AWS with no cost, so it's on.

**DNS.** The `aws_route53_zone` data source finds the zone Route 53 created for your domain. The `A` record points your hostname at the VM's public IP. The IP changes every time the VM is recreated, and Terraform updates the record in the same `apply`. The 60-second TTL tells resolvers not to cache the old IP for long.

**The cloud-init script.** `--secrets-encryption` makes k3s encrypt Kubernetes Secrets in its database on disk. Remember Phase 3's "a Secret is just base64"? This is the "encryption at rest" half of that answer.

### 7d. The database

`infra/terraform/modules/database/main.tf`:

```bash
cat > infra/terraform/modules/database/main.tf <<'EOF'
# Managed Postgres (RDS) in the private subnets, reachable only from the cluster VM.
# Terraform generates the password and stores the connection details in Secrets Manager,
# where External Secrets picks them up. No human ever types or sees the password.

variable "name" {
  description = "Prefix for resource names, like flashcards-staging"
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets, in at least two availability zones"
  type        = list(string)
}

variable "allowed_security_group_id" {
  description = "Only things in this security group (the cluster VM) may connect"
  type        = string
}

variable "secret_name" {
  description = "Secrets Manager name for the connection details, like flashcards/staging/db"
  type        = string
}

variable "instance_class" {
  description = "db.t4g.micro: 2 vCPU (burstable), 1 GB. Plenty for this app."
  type        = string
  default     = "db.t4g.micro"
}

variable "backup_retention_days" {
  description = "Days of automatic backups. 0 turns them off."
  type        = number
  default     = 0
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres, only from the cluster"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from the cluster VM"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.allowed_security_group_id]
  }

  tags = {
    Name = "${var.name}-db"
  }
}

# Letters and digits only, so it's safe inside a postgresql:// URL without escaping
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "flashcards"
  username = "flashcards"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  # One copy in one data center. multi_az = true keeps a standby in a second zone for
  # failover, which is what prod at a real company runs, for double the price.
  multi_az = false

  backup_retention_period    = var.backup_retention_days
  auto_minor_version_upgrade = true
  apply_immediately          = true

  # Learning settings, so terraform destroy just works. A real prod database has
  # deletion_protection = true and takes a final snapshot before it's deleted.
  deletion_protection = false
  skip_final_snapshot = true
}

resource "aws_secretsmanager_secret" "db" {
  name        = var.secret_name
  description = "Connection details for ${var.name} Postgres"
  # Delete right away on destroy. The default (a 7 to 30 day recovery window) would block
  # creating a secret with the same name when you apply again tomorrow.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = aws_db_instance.this.username
    password = random_password.db.result
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    dbname   = aws_db_instance.this.db_name
  })
}

output "address" {
  value = aws_db_instance.this.address
}

output "secret_name" {
  value = aws_secretsmanager_secret.db.name
}
EOF
```

- **The DB security group allows 5432 only from the cluster's security group**, not from an IP range. "Members of group X may connect" keeps working when the VM gets a new IP, and nothing else in the VPC can connect even by accident.
- **`random_password`** generates 32 letters and digits. No special characters, so it can sit inside a `postgresql://user:password@host` URL without escaping. 32 alphanumerics is still about 190 bits of randomness.
- ⚠️ **The password is in the Terraform state.** That's why the state bucket is private, encrypted and versioned. Newer Terraform can keep it out of state completely (see Known gaps), but this pattern is what most companies have run for years, and it's worth knowing why it needs a locked-down state bucket.
- **The secret is JSON** with everything needed to connect: `username`, `password`, `host`, `port`, `dbname`. External Secrets turns it into `DATABASE_URL` (Step 10). The host is only known after RDS exists, so Terraform writes it in after creating the database. You never copy an endpoint by hand.
- **`recovery_window_in_days = 0`**: by default, a deleted secret waits 7 to 30 days before it's really gone, and its name stays reserved. Then tomorrow's `apply` would fail with "a secret with this name is already scheduled for deletion". Zero deletes it right away. (The Anthropic secrets in `global` keep the default, since you never destroy those.)
- **`engine_version = "17"`** with `auto_minor_version_upgrade`: AWS picks the newest 17.x and applies minor (security) updates in the maintenance window. Locally you run Postgres 16; the app's SQL is simple enough that it doesn't care. Matching local to cloud versions exactly is a nice-to-have you can do any time.
- **The learning settings** (`deletion_protection = false`, `skip_final_snapshot = true`, `multi_az = false`) are commented on purpose. A real prod database has all three the other way round. In an interview, saying *why* you turned them off here is better than not knowing they exist.

## Step 8: The environments

The domain goes into one tiny file per environment. This is the only line that differs between your repo and anyone else's:

```bash
printf 'locals {\n  domain = "%s"\n}\n' "${FLASHCARDS_DOMAIN:?run the source command from Step 2 first}" > infra/terraform/envs/staging/domain.tf
printf 'locals {\n  domain = "%s"\n}\n' "${FLASHCARDS_DOMAIN:?run the source command from Step 2 first}" > infra/terraform/envs/prod/domain.tf
cat infra/terraform/envs/staging/domain.tf
```

You should see your real domain in quotes.

`infra/terraform/envs/staging/main.tf`:

```bash
cat > infra/terraform/envs/staging/main.tf <<'EOF'
# The staging environment: network, uploads bucket, k3s VM and Postgres.
# Every piece comes from a module in ../../modules, so staging and prod are built
# the same way and only differ in the few values below.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9.1"
    }
  }

  backend "s3" {
    bucket       = "copaaglo-flashcards-tfstate"
    key          = "envs/staging/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"

  # Tags on every resource, so the bill can be split by environment
  default_tags {
    tags = {
      Project     = "flashcards"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# local.domain comes from domain.tf in this folder
locals {
  environment = "staging"
  name        = "flashcards-staging"
  hostname    = "staging.${local.domain}"
}

module "vpc" {
  source = "../../modules/vpc"

  name = local.name
  cidr = "10.10.0.0/16"
}

module "bucket" {
  source = "../../modules/bucket"

  name = "copaaglo-flashcards-staging-uploads"
  # Learning setting: destroy deletes the bucket even with uploads in it
  force_destroy = true
}

module "cluster" {
  source = "../../modules/cluster"

  name               = local.name
  environment        = local.environment
  vpc_id             = module.vpc.vpc_id
  subnet_id          = module.vpc.public_subnet_ids[0]
  zone_name          = local.domain
  hostname           = local.hostname
  uploads_bucket_arn = module.bucket.arn
}

module "database" {
  source = "../../modules/database"

  name                      = local.name
  vpc_id                    = module.vpc.vpc_id
  subnet_ids                = module.vpc.private_subnet_ids
  allowed_security_group_id = module.cluster.security_group_id
  secret_name               = "flashcards/staging/db"
  backup_retention_days     = 0
}

output "url" {
  value = module.cluster.url
}

output "instance_id" {
  value = module.cluster.instance_id
}

output "database_address" {
  value = module.database.address
}

output "uploads_bucket" {
  value = module.bucket.name
}
EOF
```

`infra/terraform/envs/prod/main.tf`:

```bash
cat > infra/terraform/envs/prod/main.tf <<'EOF'
# The prod environment: network, uploads bucket, k3s VM and Postgres.
# Every piece comes from a module in ../../modules, so staging and prod are built
# the same way and only differ in the few values below.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9.1"
    }
  }

  backend "s3" {
    bucket       = "copaaglo-flashcards-tfstate"
    key          = "envs/prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"

  # Tags on every resource, so the bill can be split by environment
  default_tags {
    tags = {
      Project     = "flashcards"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

# local.domain comes from domain.tf in this folder
locals {
  environment = "prod"
  name        = "flashcards-prod"
  # Prod answers on the bare domain
  hostname = local.domain
}

module "vpc" {
  source = "../../modules/vpc"

  name = local.name
  cidr = "10.20.0.0/16"
}

module "bucket" {
  source = "../../modules/bucket"

  name = "copaaglo-flashcards-prod-uploads"
  # Learning setting: destroy deletes the bucket even with uploads in it
  force_destroy = true
}

module "cluster" {
  source = "../../modules/cluster"

  name               = local.name
  environment        = local.environment
  vpc_id             = module.vpc.vpc_id
  subnet_id          = module.vpc.public_subnet_ids[0]
  zone_name          = local.domain
  hostname           = local.hostname
  uploads_bucket_arn = module.bucket.arn
}

module "database" {
  source = "../../modules/database"

  name                      = local.name
  vpc_id                    = module.vpc.vpc_id
  subnet_ids                = module.vpc.private_subnet_ids
  allowed_security_group_id = module.cluster.security_group_id
  secret_name               = "flashcards/prod/db"
  backup_retention_days     = 1
}

output "url" {
  value = module.cluster.url
}

output "instance_id" {
  value = module.cluster.instance_id
}

output "database_address" {
  value = module.database.address
}

output "uploads_bucket" {
  value = module.bucket.name
}
EOF
```

Put them side by side and the differences are tiny: the state `key`, the names, the IP range, the hostname, and one day of database backups in prod. That's the point of modules. If staging works, prod is built the same way, by the same code. **Keeping staging and prod identical except for size and names is what makes staging a useful test of prod.**

- **`module "cluster"` takes `module.bucket.arn`**, and `module "database"` takes `module.cluster.security_group_id`. Terraform reads those references and works out the order (bucket before VM role, VM security group before database rule). You never write the order down.
- **Outputs** are what you'll want after an `apply`: the URL, the VM's ID for Systems Manager, the database address.

Initialize both and check them:

```bash
terraform -chdir=infra/terraform/envs/staging init
terraform -chdir=infra/terraform/envs/prod init
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/envs/staging validate
terraform -chdir=infra/terraform/envs/prod validate
```

`fmt -check` prints nothing when the formatting is right (if it lists files, run `terraform fmt -recursive infra/terraform` to fix them). Both `validate`s say `Success! The configuration is valid.`

Now look at what staging *would* create, without creating anything:

```bash
terraform -chdir=infra/terraform/envs/staging plan
```

Scroll through it. It ends with `Plan: 25 to add, 0 to change, 0 to destroy.` Find the `aws_instance`, the `aws_db_instance` and the `aws_route53_record`, and check the record's `name` is `staging.` plus your domain. **Don't apply yet.** The VM clones `main` on its first boot, so the files from the next steps have to be merged before it exists.

## Step 9: What the VM runs on first boot

### 9a. The bootstrap script

`deploy/cloud/bootstrap.sh`:

```bash
mkdir -p deploy/cloud
```

```bash
cat > deploy/cloud/bootstrap.sh <<'EOF'
#!/usr/bin/env bash
# Turns a fresh k3s VM into a cluster that Argo CD deploys the app to.
# cloud-init runs it once, as root, on the VM's first boot (infra/terraform/modules/cluster).
# Safe to run again by hand if a step failed, from a shell on the VM:
#   sudo bash /opt/flashcards/deploy/cloud/bootstrap.sh staging
set -euo pipefail

ENVIRONMENT="${1:?usage: bootstrap.sh staging|prod}"

# Pinned versions, each at least two weeks old when picked
HELM_VERSION=v4.3.1
CERT_MANAGER_VERSION=v1.21.2
EXTERNAL_SECRETS_VERSION=2.12.0
ARGOCD_CHART_VERSION=10.10.5

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# cloud-init may run us without HOME, and Helm keeps its repo list under it
export HOME="${HOME:-/root}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Helm $HELM_VERSION"
if ! helm version 2>/dev/null | grep -q "$HELM_VERSION"; then
  arch="$(uname -m | sed 's/aarch64/arm64/; s/x86_64/amd64/')"
  tarball="helm-${HELM_VERSION}-linux-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$tarball" "https://get.helm.sh/$tarball"
  curl -fsSL -o "$tmp/$tarball.sha256sum" "https://get.helm.sh/$tarball.sha256sum"
  # Refuse to install a download that doesn't match its published checksum
  (cd "$tmp" && sha256sum -c "$tarball.sha256sum")
  tar -xzf "$tmp/$tarball" -C "$tmp"
  install -m 0755 "$tmp/linux-${arch}/helm" /usr/local/bin/helm
  rm -rf "$tmp"
fi

echo "==> Waiting for the node"
until kubectl get nodes >/dev/null 2>&1; do sleep 5; done
kubectl wait --for=condition=Ready node --all --timeout=300s

helm repo add jetstack https://charts.jetstack.io --force-update
helm repo add external-secrets https://charts.external-secrets.io --force-update
helm repo add argo https://argoproj.github.io/argo-helm --force-update

echo "==> cert-manager: gets HTTPS certificates from Let's Encrypt"
helm upgrade --install cert-manager jetstack/cert-manager --version "$CERT_MANAGER_VERSION" \
  --namespace cert-manager --create-namespace --set crds.enabled=true --wait --timeout 10m

echo "==> External Secrets: copies secrets from AWS Secrets Manager into Kubernetes"
helm upgrade --install external-secrets external-secrets/external-secrets --version "$EXTERNAL_SECRETS_VERSION" \
  --namespace external-secrets --create-namespace --wait --timeout 10m

echo "==> Argo CD"
helm upgrade --install argocd argo/argo-cd --version "$ARGOCD_CHART_VERSION" \
  --namespace argocd --create-namespace -f "$REPO_DIR/deploy/argocd/argocd-values.yaml" --wait --timeout 10m

echo "==> Handing flashcards-$ENVIRONMENT to Argo CD"
kubectl apply -n argocd -f "$REPO_DIR/deploy/argocd/flashcards-$ENVIRONMENT.yaml"

echo "==> Bootstrap done. Argo CD deploys the app from Git now."
EOF
```

```bash
chmod +x deploy/cloud/bootstrap.sh
```

It's the Phase 4 Argo CD install, plus two new pieces, as a script:
- **Helm, verified.** It downloads Helm and refuses to install it unless the checksum matches the one Helm publishes. "Pipe a download straight into your system" is how supply-chain attacks land; checking a checksum is the cheap defense.
- **cert-manager** watches Ingresses that ask for a certificate, proves to Let's Encrypt that you control the domain, and keeps the certificate renewed. `crds.enabled=true` installs its custom resource types (`Certificate`, `Issuer`, ...).
- **External Secrets** watches `ExternalSecret` objects and turns them into normal Kubernetes Secrets, using values from Secrets Manager.
- **Argo CD**, with the same values file as on kind, then the Application for this environment. From that moment, Git drives everything.
- **Every chart pinned**, same rule as always, each version at least two weeks old when I picked it.
- **Safe to re-run.** `helm upgrade --install` and `kubectl apply` don't mind running twice, so if a step fails (a download timing out, say), you run the whole script again from a shell on the VM.

### 9b. Argo CD settings and the two Applications

`deploy/argocd/argocd-values.yaml` (only the comments change, same settings):

```bash
cat > deploy/argocd/argocd-values.yaml <<'EOF'
# Settings for Argo CD, on the local kind cluster and on the cloud clusters.
# Locally: the helm command in guides/phase4 Step 8. Cloud: deploy/cloud/bootstrap.sh.
# Only overrides go here.

configs:
  cm:
    # How often Argo CD checks Git for new commits. Default is 120s.
    # Without a GitHub webhook (see Known gaps), polling is how it notices a merge.
    timeout.reconciliation: 60s
    timeout.reconciliation.jitter: 10s

# Things we don't use yet, turned off to save memory
dex:
  enabled: false
notifications:
  enabled: false
applicationSet:
  replicas: 0
EOF
```

`deploy/argocd/flashcards-staging.yaml`:

```bash
cat > deploy/argocd/flashcards-staging.yaml <<'EOF'
# Tells Argo CD: keep namespace flashcards-staging in sync with the Helm chart on main,
# rendered with values-staging.yaml. Argo CD runs inside the staging cloud cluster, and
# deploy/cloud/bootstrap.sh applies this file when the cluster is created.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: flashcards-staging
  namespace: argocd
spec:
  project: default
  source:
    # Public repo, so Argo CD needs no credentials to read it
    repoURL: https://github.com/copaaglo/flashcards.git
    targetRevision: main
    path: deploy/helm/flashcards
    helm:
      releaseName: flashcards
      valueFiles:
        - values-staging.yaml
  destination:
    # "This cluster", the one Argo CD runs in
    server: https://kubernetes.default.svc
    namespace: flashcards-staging
  syncPolicy:
    automated:
      # Delete objects that were removed from Git
      prune: true
      # Undo changes made by hand in the cluster (drift)
      selfHeal: true
    syncOptions:
      # Create the namespace on the first sync, so there's no manual step to forget
      - CreateNamespace=true
EOF
```

`deploy/argocd/flashcards-prod.yaml`:

```bash
cat > deploy/argocd/flashcards-prod.yaml <<'EOF'
# Tells Argo CD: keep namespace flashcards-prod in sync with the Helm chart on main,
# rendered with values-prod.yaml. Argo CD runs inside the prod cloud cluster, and
# deploy/cloud/bootstrap.sh applies this file when the cluster is created.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: flashcards-prod
  namespace: argocd
spec:
  project: default
  source:
    # Public repo, so Argo CD needs no credentials to read it
    repoURL: https://github.com/copaaglo/flashcards.git
    targetRevision: main
    path: deploy/helm/flashcards
    helm:
      releaseName: flashcards
      valueFiles:
        - values-prod.yaml
  destination:
    # "This cluster", the one Argo CD runs in
    server: https://kubernetes.default.svc
    namespace: flashcards-prod
  syncPolicy:
    automated:
      # Delete objects that were removed from Git
      prune: true
      # Undo changes made by hand in the cluster (drift)
      selfHeal: true
    syncOptions:
      # Create the namespace on the first sync, so there's no manual step to forget
      - CreateNamespace=true
EOF
```

- **One new line, `CreateNamespace=true`**: Argo CD creates the namespace on the first sync. In Phase 4 the staging namespace was a manual step, and skipping it broke the first sync. Things that can be forgotten should be automated away.
- **The destination is still `https://kubernetes.default.svc`**, "the cluster I'm running in". Each cloud cluster has its own Argo CD that only manages itself. The other common setup is one central Argo CD managing many clusters; that needs it to hold credentials for every cluster, which is a tradeoff worth mentioning in an interview.

### 9c. A tunnel to the cluster from your Mac

`scripts/cloud-connect.sh`:

```bash
cat > scripts/cloud-connect.sh <<'EOF'
#!/usr/bin/env bash
# Opens a private tunnel from your Mac to a cloud cluster's Kubernetes API, through
# AWS Systems Manager (SSM). No SSH, no open ports on the VM.
#   bash scripts/cloud-connect.sh staging      (or prod)
# Leave it running. In another terminal tab:
#   export KUBECONFIG=~/.kube/flashcards-staging.yaml
#   kubectl get nodes
set -euo pipefail

ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
  staging) LOCAL_PORT=16443 ;;
  prod) LOCAL_PORT=26443 ;;
  *) echo "usage: bash scripts/cloud-connect.sh staging|prod"; exit 1 ;;
esac
export AWS_REGION="${AWS_REGION:-us-east-1}"
KUBECONFIG_FILE="$HOME/.kube/flashcards-$ENVIRONMENT.yaml"

INSTANCE_ID="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=flashcards-$ENVIRONMENT" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "No running flashcards-$ENVIRONMENT VM. Did terraform apply finish?"
  exit 1
fi
echo "VM: $INSTANCE_ID"

# Read k3s's admin kubeconfig by running one command on the VM through SSM
COMMAND_ID="$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["cat /etc/rancher/k3s/k3s.yaml"]' --query Command.CommandId --output text)"
aws ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
mkdir -p "$HOME/.kube"
# The file points at 127.0.0.1:6443 on the VM. We reach it through the tunnel on LOCAL_PORT.
aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text \
  | sed "s|https://127.0.0.1:6443|https://127.0.0.1:$LOCAL_PORT|" > "$KUBECONFIG_FILE"
# It's a cluster-admin credential, so only you can read it
chmod 600 "$KUBECONFIG_FILE"
grep -q "127.0.0.1:$LOCAL_PORT" "$KUBECONFIG_FILE" || { echo "Kubeconfig looks wrong, k3s may still be installing. Try again in a minute."; exit 1; }
echo "Wrote $KUBECONFIG_FILE"

echo "Tunnel: 127.0.0.1:$LOCAL_PORT -> $INSTANCE_ID:6443. Leave this running, Ctrl+C closes it."
exec aws ssm start-session --target "$INSTANCE_ID" --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=6443,localPortNumber=$LOCAL_PORT"
EOF
```

```bash
chmod +x scripts/cloud-connect.sh
```

How it works: k3s writes an admin kubeconfig on the VM that points at `127.0.0.1:6443`. The script reads it through Systems Manager, changes the port to a local one (16443 for staging, 26443 for prod, so you can have both open), saves it as `~/.kube/flashcards-staging.yaml`, and then opens a Systems Manager **port forward** from that local port to the VM's 6443. kubectl on your Mac talks to `127.0.0.1:16443`, and the tunnel carries it to the cluster. Your kind cluster's kubeconfig isn't touched.

## Step 10: Chart changes for the cloud

Your chart was designed for this in Phase 3: it reads a Secret by name and never creates it, it doesn't contain Postgres or S3, and it uses the standard Ingress object. So the changes are small, and the local dev render doesn't change at all.

### 10a. New settings in values.yaml

Restores `values.yaml` to what's committed, then appends, so it's **safe to paste twice**:

```bash
git restore deploy/helm/flashcards/values.yaml
cat >> deploy/helm/flashcards/values.yaml <<'EOF'

# Which keys of existingSecret each app reads. Only the worker gets the Anthropic key.
# In the cloud the AWS keys go away: pods use the VM's IAM role instead (see values-staging.yaml).
secretKeys:
  api: [DATABASE_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
  worker: [DATABASE_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ANTHROPIC_API_KEY]

# Make existingSecret from AWS Secrets Manager with External Secrets. Cloud only.
externalSecrets:
  enabled: false
  region: us-east-1
  # Secret names in Secrets Manager start with this, like flashcards/staging
  prefix: ""

# Redis (the job queue) as part of the chart. Cloud only: locally, dev-deps.yaml runs it.
redis:
  enabled: false
  image: redis:7

# HTTPS with a free Let's Encrypt certificate, requested by cert-manager. Needs ingress.host.
tls:
  enabled: false
  acmeServer: https://acme-v02.api.letsencrypt.org/directory
EOF
tail -25 deploy/helm/flashcards/values.yaml
```

Every new feature is **off by default**, so kind and `kind-deploy.sh` behave exactly like before.

### 10b. Which Secret keys each app reads

The cloud Secret won't have AWS keys (pods use the VM's role), and a Deployment that references a missing key never starts. So the key lists move from the templates into values:

```bash
sed -i '' 's|(list "DATABASE_URL" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY"))|.Values.secretKeys.api)|' deploy/helm/flashcards/templates/api.yaml
sed -i '' 's|(list "DATABASE_URL" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" "ANTHROPIC_API_KEY"))|.Values.secretKeys.worker)|' deploy/helm/flashcards/templates/worker.yaml
grep -n secretKeys deploy/helm/flashcards/templates/api.yaml deploy/helm/flashcards/templates/worker.yaml
```

You want exactly two lines back, one per file. If `grep` prints nothing, your `include "flashcards.secretEnv"` lines are different from the Phase 3 guide: open the two files and replace the `(list "DATABASE_URL" ...)` part with `.Values.secretKeys.api` and `.Values.secretKeys.worker` by hand.

### 10c. HTTPS: Ingress and Issuer

`deploy/helm/flashcards/templates/ingress.yaml` (whole file):

```bash
cat > deploy/helm/flashcards/templates/ingress.yaml <<'EOF'
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: flashcards
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
  {{- if .Values.tls.enabled }}
  annotations:
    # cert-manager watches for this, gets a certificate for the host below from the
    # "letsencrypt" Issuer (issuer.yaml) and stores it in the flashcards-tls Secret
    cert-manager.io/issuer: letsencrypt
  {{- end }}
spec:
  ingressClassName: {{ .Values.ingress.className }}
  {{- if .Values.tls.enabled }}
  tls:
    - hosts:
        - {{ required "tls.enabled needs ingress.host" .Values.ingress.host | quote }}
      secretName: flashcards-tls
  {{- end }}
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  name: http
      {{- with .Values.ingress.host }}
      host: {{ . | quote }}
      {{- end }}
{{- end }}
EOF
```

`deploy/helm/flashcards/templates/issuer.yaml`:

```bash
cat > deploy/helm/flashcards/templates/issuer.yaml <<'EOF'
{{- if .Values.tls.enabled }}
# Tells cert-manager how to get certificates: from Let's Encrypt, proving we own the
# domain by answering an HTTP request on it (the "HTTP-01 challenge") through Traefik.
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: letsencrypt
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
spec:
  acme:
    server: {{ .Values.tls.acmeServer }}
    # cert-manager creates this Secret itself: the key for our Let's Encrypt account
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: {{ .Values.ingress.className }}
{{- end }}
EOF
```

How you get a certificate without touching anything:
1. The Ingress has a `tls` section and the `cert-manager.io/issuer` annotation.
2. cert-manager sees it, creates a `Certificate` and asks Let's Encrypt for one.
3. Let's Encrypt says "prove you control this name: serve this token at `http://<host>/.well-known/acme-challenge/...`". That's the **HTTP-01 challenge**, and it's why port 80 is open.
4. cert-manager creates a temporary Ingress through Traefik that answers with the token. Let's Encrypt checks it over the internet, issues the certificate, and cert-manager stores it in the `flashcards-tls` Secret.
5. Traefik serves HTTPS with it. cert-manager renews it before it expires, forever, by itself.

It's an **Issuer** (one namespace) rather than a **ClusterIssuer** (whole cluster) so it's part of the app's chart and Argo CD manages it like everything else.

### 10d. Secrets from Secrets Manager

`deploy/helm/flashcards/templates/external-secrets.yaml`:

```bash
cat > deploy/helm/flashcards/templates/external-secrets.yaml <<'EOF'
{{- if .Values.externalSecrets.enabled }}
# Where External Secrets reads from: AWS Secrets Manager. No credentials here on purpose.
# The controller uses the VM's IAM role, which may only read this environment's secrets.
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
spec:
  provider:
    aws:
      service: SecretsManager
      region: {{ .Values.externalSecrets.region }}
---
# Builds the same Secret you made by hand in Phase 3 (existingSecret), from two
# Secrets Manager entries. The api and worker templates don't know the difference.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: {{ .Values.existingSecret }}
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
spec:
  # How often to re-read Secrets Manager. A changed value lands in the Secret within this time.
  refreshInterval: 1h
  secretStoreRef:
    kind: SecretStore
    name: aws-secrets-manager
  target:
    name: {{ .Values.existingSecret }}
    # The ExternalSecret owns the Secret: delete one and the other goes too
    creationPolicy: Owner
    template:
      engineVersion: v2
      # The inner double-brace parts are External Secrets templates, not Helm ones. The backticks make
      # Helm pass them through untouched.
      data:
        DATABASE_URL: {{ `postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .dbname }}?sslmode=require` | quote }}
        ANTHROPIC_API_KEY: {{ `{{ .anthropicApiKey }}` | quote }}
  # The JSON written by Terraform (username, password, host, port, dbname), one key per field
  dataFrom:
    - extract:
        key: {{ required "externalSecrets.prefix is required" .Values.externalSecrets.prefix }}/db
  # The plain-text API key you put in with the AWS CLI
  data:
    - secretKey: anthropicApiKey
      remoteRef:
        key: {{ .Values.externalSecrets.prefix }}/anthropic-api-key
{{- end }}
EOF
```

- **The SecretStore has no credentials in it.** External Secrets uses the AWS SDK's normal lookup, which finds the VM's IAM role through the metadata endpoint. Nothing to leak.
- **The ExternalSecret's name is `flashcards-secrets`**, the same `existingSecret` name your api and worker already read. This is the promise from Phase 3 Step 5 coming true: the Secret now comes from AWS instead of a `kubectl` command, and the Deployments don't change at all.
- **`dataFrom.extract`** pulls every field out of the database JSON. **`data`** pulls the plain-text Anthropic key.
- **`template`** builds the final Secret from those pieces. `DATABASE_URL` is assembled from the parts, with **`sslmode=require`**, so the connection to RDS is encrypted. The backticks are a Helm trick: Helm and External Secrets both use `{{ }}`, and a Go raw string makes Helm pass External Secrets' templates through untouched.
- **`refreshInterval: 1h`**: change a value in Secrets Manager and the Kubernetes Secret updates within the hour. (Pods only read env vars at start, so they'd need a restart to see it. Known gaps.)

### 10e. Redis in the chart (cloud only)

`deploy/helm/flashcards/templates/redis.yaml`:

```bash
cat > deploy/helm/flashcards/templates/redis.yaml <<'EOF'
{{- if .Values.redis.enabled }}
# Redis for the job queue, in the cloud clusters. No disk on purpose: it only holds
# job IDs waiting for a worker. A managed Redis (ElastiCache) would add about $12/month.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- include "flashcards.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: redis
  template:
    metadata:
      # Selector labels only, no version label: a deploy of new app code shouldn't restart Redis
      labels:
        {{- include "flashcards.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: redis
    spec:
      enableServiceLinks: false
      containers:
        - name: redis
          image: {{ .Values.redis.image }}
          # Never write snapshots to disk (there is no disk to write to)
          args: ["--save", "", "--appendonly", "no"]
          ports:
            - name: redis
              containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 128Mi
          securityContext:
            runAsNonRoot: true
            # The redis user in the official image
            runAsUser: 999
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            seccompProfile:
              type: RuntimeDefault
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  labels:
    {{- include "flashcards.labels" . | nindent 4 }}
    app.kubernetes.io/component: redis
spec:
  selector:
    {{- include "flashcards.selectorLabels" . | nindent 4 }}
    app.kubernetes.io/component: redis
  ports:
    - name: redis
      port: 6379
      targetPort: redis
{{- end }}
EOF
```

Same Redis as `dev-deps.yaml`, plus resource limits and a locked-down security context (Redis's image has a `redis` user, UID 999). The pod template uses only the **selector labels**, not the version label. Otherwise every app deploy would change the Redis pod template and restart Redis, dropping whatever jobs were waiting in the queue.

### 10f. values-staging.yaml and values-prod.yaml

These two use your domain, so they start with a check: if `FLASHCARDS_DOMAIN` is empty, nothing gets written and you see an error instead. Whole files, **safe to paste twice**.

`deploy/helm/flashcards/values-staging.yaml`:

```bash
echo "Domain: ${FLASHCARDS_DOMAIN:?run the source command from Step 2 first}" && cat > deploy/helm/flashcards/values-staging.yaml <<EOF
# Staging overrides. Argo CD on the staging cloud cluster (k3s on AWS, built by
# infra/terraform/envs/staging) deploys the chart with this file on top of values.yaml.
# Only differences from values.yaml go here.

image:
  registry: ghcr.io/copaaglo
  # Written by release.yml on every merge to main that changes app code. Don't edit by hand.
  tag: bootstrap

config:
  # Real model calls, so staging behaves like prod. Costs a little per smoke test.
  FAKE_LLM: "0"
  # Empty = the app uses AWS's normal S3 endpoint instead of the local SeaweedFS
  S3_ENDPOINT: ""
  # Made by Terraform (modules/bucket)
  S3_BUCKET: copaaglo-flashcards-staging-uploads

# No AWS keys: pods get AWS access from the VM's IAM role
secretKeys:
  api: [DATABASE_URL]
  worker: [DATABASE_URL, ANTHROPIC_API_KEY]

# flashcards-secrets is built from Secrets Manager entries named flashcards/staging/...
externalSecrets:
  enabled: true
  prefix: flashcards/staging

redis:
  enabled: true

ingress:
  host: staging.${FLASHCARDS_DOMAIN}

tls:
  enabled: true

smokeTest:
  enabled: true
EOF
```

`deploy/helm/flashcards/values-prod.yaml`:

```bash
echo "Domain: ${FLASHCARDS_DOMAIN:?run the source command from Step 2 first}" && cat > deploy/helm/flashcards/values-prod.yaml <<EOF
# Prod overrides. Argo CD on the prod cloud cluster (infra/terraform/envs/prod) deploys
# the chart with this file on top of values.yaml. Only differences from values.yaml go here.

image:
  registry: ghcr.io/copaaglo
  # Copied from values-staging.yaml by the "Promote to prod" workflow, after someone
  # approves it. Prod only ever runs images that ran on staging first. Don't edit by hand.
  tag: bootstrap

config:
  FAKE_LLM: "0"
  S3_ENDPOINT: ""
  S3_BUCKET: copaaglo-flashcards-prod-uploads

secretKeys:
  api: [DATABASE_URL]
  worker: [DATABASE_URL, ANTHROPIC_API_KEY]

externalSecrets:
  enabled: true
  prefix: flashcards/prod

redis:
  enabled: true

# Two of each, so one pod can die or be replaced during a deploy without downtime
web:
  replicas: 2

api:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      memory: 512Mi

worker:
  replicas: 2

ingress:
  # Prod answers on the bare domain
  host: ${FLASHCARDS_DOMAIN}

tls:
  enabled: true

# Same check as staging after every prod deploy. One real LLM call, about a cent.
smokeTest:
  enabled: true
EOF
```

- **`tag: bootstrap` again.** The merge of this PR changes app code (Step 11), so `release.yml` will build new images and write their SHA into `values-staging.yaml`. Prod gets its tag from the new promotion workflow (Step 12).
- **`S3_ENDPOINT: ""`**: locally the app talks to SeaweedFS at `http://s3:8333`. In AWS there's no endpoint to set, the SDK knows where S3 is. The empty string plus the app change in Step 11 means "use real AWS".
- **`secretKeys` without AWS keys**: the pods get AWS credentials from the VM's role.
- **Prod reuses Phase 3's replica counts**: two of each, so a deploy or a crashed pod doesn't cause downtime.
- **The smoke test runs in prod too.** One real LLM call per deploy, about a cent. "A deploy isn't done until something proves it works" applies most of all to prod.

Check all three values files, then look at the cloud render:

```bash
helm lint --strict deploy/helm/flashcards
helm lint --strict deploy/helm/flashcards -f deploy/helm/flashcards/values-staging.yaml
helm lint --strict deploy/helm/flashcards -f deploy/helm/flashcards/values-prod.yaml
helm template flashcards deploy/helm/flashcards -f deploy/helm/flashcards/values-staging.yaml | grep -E "^kind:|host:|DATABASE_URL|S3_"
```

All three lint `0 chart(s) failed`. The render should list an `ExternalSecret`, a `SecretStore`, an `Issuer`, a `redis` Deployment, your staging hostname, and `S3_ENDPOINT: ""`.

And prove dev didn't change: the default render still has the AWS keys and the local S3:

```bash
helm template flashcards deploy/helm/flashcards | grep -E "AWS_ACCESS_KEY_ID|S3_ENDPOINT"
```

## Step 11: One line of app code

boto3 with `endpoint_url=""` fails ("Invalid endpoint"), and any endpoint URL makes boto3 use old-style "path" addressing. With `None`, boto3 talks to AWS S3 the normal way. So: empty or unset means real AWS. This edits the same line in the api and the worker:

```bash
sed -i '' 's/^S3_ENDPOINT = os.environ\["S3_ENDPOINT"\]$/S3_ENDPOINT = os.environ.get("S3_ENDPOINT") or None  # unset or empty = real AWS S3/' apps/api/main.py apps/worker/worker/tasks.py
git diff apps/
```

Exactly two changed lines. Locally nothing changes, because Compose and kind still set `S3_ENDPOINT=http://s3:8333`. Run the unit tests the Phase 2 way to be sure:

```bash
docker run --rm -v "$PWD/apps/api":/app -w /app python:3.12-slim sh -c "pip install -q -r requirements-dev.txt && pytest -q"
docker run --rm -v "$PWD/apps/worker":/app -w /app python:3.12-slim sh -c "pip install -q -r requirements-dev.txt && pytest -q"
```

Both green, same counts as before.

This is the only app change in the whole phase, which is the payoff for Phase 1's "code against the S3 API, not a vendor".

## Step 12: Workflows

### 12a. Staging's URL in release.yml

One line, the link GitHub shows on the staging environment:

```bash
sed -i '' "s|url: http://staging.localhost:8080|url: https://staging.${FLASHCARDS_DOMAIN:?run the source command from Step 2 first}|" .github/workflows/release.yml
grep -n "url:" .github/workflows/release.yml
```

### 12b. Promote to prod

`.github/workflows/promote-prod.yml`:

```bash
cat > .github/workflows/promote-prod.yml <<'EOF'
name: Promote to prod

# Copies the image tag that staging runs into values-prod.yaml. Argo CD on the prod
# cluster sees that commit and deploys it. The job waits for a person to approve it
# (the production Environment has required reviewers), so nothing reaches prod by itself.
on:
  # After every successful release: offer the new staging version to prod
  workflow_run:
    workflows: [Release]
    types: [completed]
  # A "Run workflow" button: promote whatever staging runs right now
  workflow_dispatch:

permissions:
  contents: read

# One promotion at a time. A newer one waits instead of racing it.
concurrency:
  group: promote-prod
  cancel-in-progress: false

jobs:
  promote-prod:
    name: Promote to prod
    # Only after a release that succeeded (a failed release never reached staging)
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    # Required reviewers on this environment make the job pause until someone approves.
    # Its DEPLOY_KEY secret is a second deploy key, only for prod promotions.
    environment: production
    steps:
      - uses: actions/checkout@v7
        with:
          # Latest main, read after the approval: prod gets what staging runs at that moment
          ref: main
          ssh-key: ${{ secrets.DEPLOY_KEY }}

      - name: Copy the staging image tag to prod
        env:
          FROM: deploy/helm/flashcards/values-staging.yaml
          TO: deploy/helm/flashcards/values-prod.yaml
        run: |
          TAG="$(yq '.image.tag' "$FROM")"
          # Only ever a full commit SHA, never "bootstrap" or anything else
          if ! echo "$TAG" | grep -Eq '^[0-9a-f]{40}$'; then
            echo "Staging runs '$TAG', which is not a commit SHA. Nothing to promote."
            exit 1
          fi
          sed -i -E "s/^  tag: .*/  tag: ${TAG}/" "$TO"
          test "$(yq '.image.tag' "$TO")" = "$TAG"
          echo "TAG=$TAG" >> "$GITHUB_ENV"
          git diff

      - name: Commit and push to main
        run: |
          git config user.name "flashcards-deploy-bot"
          git config user.email "flashcards-deploy-bot@users.noreply.github.com"
          git add deploy/helm/flashcards/values-prod.yaml
          if git diff --cached --quiet; then
            echo "Prod already runs $TAG"
            exit 0
          fi
          git commit -m "Deploy ${TAG:0:7} to prod [skip ci]" -m "Promoted from staging by run $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID, approved in the production environment"
          for attempt in 1 2 3; do
            if git push origin HEAD:main; then
              exit 0
            fi
            echo "Push rejected (main moved). Rebasing and retrying, attempt $attempt"
            git pull --rebase origin main
          done
          exit 1
EOF
```

How it fits together:
- **`workflow_run`**: when `Release` finishes successfully (so staging just got a new tag), this workflow starts. It immediately pauses at the `production` environment, because that environment has **required reviewers** (Step 13). You get a notification and a yellow "Waiting" run.
- **You check staging, then click Approve.** That's the "manual approval" from the project plan, and it's how real teams gate prod: a deploy needs a person to say yes, and GitHub records who and when.
- **It copies whatever staging runs at the moment you approve**, read from `values-staging.yaml` on `main`. So prod only ever runs images that ran on staging first. The check that the tag is a 40-character SHA stops it from ever promoting `bootstrap` or a typo.
- **`workflow_dispatch`** gives you a **Run workflow** button too, to promote staging's current version any time.
- **A separate deploy key** in the `production` environment. Separate keys per environment means you can revoke one without touching the other.
- **Why a separate workflow and not a third job in release.yml?** A job waiting for approval keeps its whole workflow run open, and `release.yml` only runs one at a time. Your next merge's staging deploy would sit behind a prod approval you haven't clicked yet. Separate workflows, separate queues.

Pending approvals you never click expire after 30 days. You can also **Reject** one, which just ends that run.

### 12c. Lint the Terraform in CI

Same idea as `Lint (helm)` in Phase 3: a broken `.tf` file should fail the PR, not your next `apply`. Open `.github/workflows/ci.yml` in your editor and add this job next to the other lint jobs (same indentation as `lint-web:`):

```yaml
  lint-terraform:
    name: Lint (terraform)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1
        with:
          terraform_version: 1.16.7
          # Plain terraform output, no wrapper script around it
          terraform_wrapper: false
      - name: Formatting
        run: terraform fmt -check -recursive -diff infra/terraform
      - name: Validate each root (no AWS credentials needed)
        run: |
          for root in bootstrap global envs/staging envs/prod; do
            echo "== $root"
            terraform -chdir="infra/terraform/$root" init -backend=false -input=false
            terraform -chdir="infra/terraform/$root" validate
          done
```

Then add `lint-terraform` to the `needs:` list of the `ci-passed` job:

```yaml
    needs: [lint-python, lint-web, lint-helm, lint-terraform, test, build-and-scan]
```

(Keep anything else you have in that list.) `validate` with `-backend=false` checks the code without touching your state or needing AWS credentials, which CI doesn't have and shouldn't. The `setup-terraform` action is pinned by commit SHA like your other third-party actions.

## Step 13: GitHub setup for prod

Do this **before** merging. The merge starts the promotion workflow, and if the `production` environment doesn't exist yet, GitHub creates an empty one with no reviewers.

### 13a. A second deploy key

```bash
ssh-keygen -t ed25519 -f ~/.ssh/flashcards-deploy-prod -N "" -C "flashcards promote-prod bot"
gh repo deploy-key add ~/.ssh/flashcards-deploy-prod.pub --repo copaaglo/flashcards --title "promote-prod bot" --allow-write
gh repo deploy-key list --repo copaaglo/flashcards
```

Two keys in the list now. Your ruleset's bypass list says **Deploy keys** (all of them), so nothing to change there.

### 13b. The production environment

Your repo > **Settings > Environments > New environment**:
1. Name: `production` (exactly).
2. Tick **Required reviewers** and add yourself (`copaaglo`). Leave **Prevent self-review** off, since you're the only person on this repo. On a team you'd turn it on, so nobody approves their own deploy.
3. **Deployment branches and tags**: **Selected branches and tags** > add `main`.
4. Save.

Then the private key, and delete your local copy (same as Phase 4):

```bash
gh secret set DEPLOY_KEY --repo copaaglo/flashcards --env production < ~/.ssh/flashcards-deploy-prod
gh secret list --repo copaaglo/flashcards --env production
rm ~/.ssh/flashcards-deploy-prod
```

## Step 14: Retire staging on kind, then merge

Once this PR merges, `values-staging.yaml` describes the cloud (External Secrets, a real hostname). The Argo CD on your kind cluster would try to deploy that and fail. Staging lives in the cloud now, so take it off kind first. Your dev release in the `flashcards` namespace isn't touched.

In a terminal tab where `kubectl` talks to kind (a new tab is fine):

```bash
kubectl config use-context kind-flashcards
kubectl delete application flashcards-staging -n argocd
kubectl delete namespace flashcards-staging
helm uninstall argocd -n argocd
kubectl delete namespace argocd
kubectl get namespaces
```

Deleting the Application doesn't delete what it deployed (there's no finalizer on it), so the namespace delete is what removes staging's pods and its Postgres. `get namespaces` should show `flashcards` and `traefik` but no `argocd` or `flashcards-staging`. Docker Desktop gets a lot of memory back.

Now commit. Look at the list before you commit: it should be only this phase's files, with **no** `.tfstate`, **no** `.tfvars` and **no** `.terraform/` folder.

```bash
git add -A infra deploy scripts apps .github .gitignore
git status
```

```bash
git commit -m "Phase 5: Terraform for staging and prod on AWS, cloud chart settings, prod promotion"
git push -u origin phase5-cloud
gh pr create --fill
gh pr checks --watch
```

The new **Lint (terraform)** check appears and goes green with the rest. Merge:

```bash
gh pr merge --squash --delete-branch
```

Watch the release:

```bash
gh run list --limit 5
gh run watch
```

Pick the newest **Release**. When it's green, `main` has the bot's `Deploy abc1234 to staging [skip ci]` commit. A **Promote to prod** run also appears, **Waiting** for review. **Leave it waiting.** You'll approve it after you've seen staging work, which is the whole point.

```bash
git switch main
git pull
grep "tag:" deploy/helm/flashcards/values-staging.yaml deploy/helm/flashcards/values-prod.yaml
```

Staging has a full SHA, prod still says `bootstrap`.

## Step 15: Build staging 💸

From here on the meter runs, about 6 cents an hour for staging. Note the time you start.

```bash
terraform -chdir=infra/terraform/envs/staging apply
```

Read the plan (`25 to add`), type `yes`. Most resources take seconds. **RDS takes 5 to 10 minutes**, the rest waits for nothing else. Expected ending:

```
Apply complete! Resources: 25 added, 0 changed, 0 destroyed.

Outputs:

database_address = "flashcards-staging.xxxxxxxxxxxx.us-east-1.rds.amazonaws.com"
instance_id = "i-0123456789abcdef0"
uploads_bucket = "copaaglo-flashcards-staging-uploads"
url = "https://staging.yourdomain.click"
```

Meanwhile the VM has booted and is installing. Watch it from inside, through Systems Manager (no SSH):

```bash
aws ssm start-session --target "$(terraform -chdir=infra/terraform/envs/staging output -raw instance_id)"
```

If it says `TargetNotConnected`, the VM's agent hasn't checked in yet: wait a minute and try again. Once you're in (you get a `$` prompt on the VM):

```bash
sudo tail -f /var/log/cloud-init-output.log
```

You'll see k3s install, then the `==>` lines from `bootstrap.sh`. It takes about 5 minutes. When you see `==> Bootstrap done. Argo CD deploys the app from Git now.`, press `Ctrl+C`, then type `exit` to leave the VM.

## Step 16: Look around staging

### 16a. Connect

In a **second terminal tab**, open the tunnel and leave it running:

```bash
cd ~/flashcards
bash scripts/cloud-connect.sh staging
```

It prints the VM ID, `Wrote .../flashcards-staging.yaml`, and then waits with the tunnel open. Back in your **first tab**:

```bash
export KUBECONFIG=~/.kube/flashcards-staging.yaml
kubectl get nodes
kubectl get applications -n argocd
kubectl get pods -A
```

One node, `Ready`. The application should be `Synced` and `Healthy` (or getting there, give it a couple of minutes). Pods in `kube-system` (k3s and Traefik), `cert-manager`, `external-secrets`, `argocd` and `flashcards-staging`.

`export KUBECONFIG` only affects that one tab. Any other tab still talks to kind. That's a common way to keep clusters apart, and it's why the prompt-shows-the-cluster tools (like `kube-ps1`) are popular.

### 16b. Follow the chain

Every piece you built, in order:

```bash
kubectl get externalsecret,secret -n flashcards-staging
kubectl get issuer,certificate -n flashcards-staging
kubectl get ingress -n flashcards-staging
kubectl logs -n flashcards-staging job/smoke-test
```

- The ExternalSecret is `SecretSynced`, and `flashcards-secrets` exists next to it: Secrets Manager reached the cluster.
- The Issuer and Certificate are `True` (Ready): Let's Encrypt issued a certificate.
- The Ingress has your hostname and an address.
- The smoke test ends with `PASS: ... cards generated` and `mode: real LLM`: the whole pipeline works against RDS, S3 and the real model.

Now the moment: open **https://staging.yourdomain.click** (your domain) in a browser. A padlock, a real certificate, your app. Upload a lecture and get cards. And from your Mac, the smoke test from outside, through DNS, TLS and the Ingress:

```bash
bash scripts/smoke-test.sh deploy/helm/flashcards/files/smoke.pdf "https://staging.$FLASHCARDS_DOMAIN"
```

Proof that uploads go to real S3, with no AWS keys anywhere in the cluster:

```bash
aws s3 ls s3://copaaglo-flashcards-staging-uploads/uploads/
```

### 16c. The Argo CD UI

In a **third tab** (leave it running):

```bash
export KUBECONFIG=~/.kube/flashcards-staging.yaml
kubectl port-forward -n argocd svc/argocd-server 8443:443
```

Password, back in the first tab:

```bash
kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d; echo
```

https://localhost:8443, user `admin`. Same tree as on kind, now with an ExternalSecret, an Issuer and a Certificate in it. It's a new password every time the cluster is rebuilt.

## Step 17: Prod

### 17a. Approve the promotion

Staging works, so approve the waiting run: your repo > **Actions** > **Promote to prod** > the waiting run > **Review deployments** > tick **production** > **Approve and deploy**.

```bash
gh run watch
git pull
grep "tag:" deploy/helm/flashcards/values-prod.yaml
```

The bot's `Deploy abc1234 to prod [skip ci]` commit is on `main`, and prod now names the same SHA as staging. Prod has no cluster yet, and that's fine: Git says what prod *should* run, and the cluster will follow when it exists.

### 17b. Build it 💸

Another 6 cents an hour on top of staging.

```bash
terraform -chdir=infra/terraform/envs/prod apply
```

`25 to add`, `yes`, wait for RDS. Watch the first boot like in Step 15 if you want (`envs/prod` instead of `envs/staging`), or just give it 10 minutes. Then a tunnel on prod's own port, in another tab:

```bash
cd ~/flashcards
bash scripts/cloud-connect.sh prod
```

```bash
export KUBECONFIG=~/.kube/flashcards-prod.yaml
kubectl get applications -n argocd
kubectl get pods -n flashcards-prod
kubectl logs -n flashcards-prod job/smoke-test
```

Two pods each of web, api and worker. Open **https://yourdomain.click** (your bare domain). That's prod.

## Step 18: The full loop

One change, PR to prod, and the only thing you touch after the merge is the Approve button.

```bash
git switch main
git pull
git switch -c cloud-deploy-test
sed -i '' 's|(shipped by Argo CD)|(shipped to AWS by Argo CD)|' apps/web/src/App.jsx
git diff
```

One changed line. If `git diff` shows nothing, your heading is different (maybe Phase 4 Step 11 isn't merged yet): edit the `<h1>` in `apps/web/src/App.jsx` by hand. Then:

```bash
git commit -am "Say where the page is deployed"
git push -u origin cloud-deploy-test
gh pr create --fill
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Then watch it happen:
1. **Release** builds and pushes images, and **Promote to staging** commits the tag.
2. Within about a minute, staging's Argo CD syncs, rolls the pods and runs the smoke test. Refresh https://staging.yourdomain.click: new heading. Prod still shows the old one.
3. **Promote to prod** is waiting. Approve it.
4. Prod's Argo CD syncs, two-by-two rolling update, smoke test. Refresh https://yourdomain.click: new heading.

Your deploy history for both environments, straight from Git:

```bash
git pull
git log --oneline -- deploy/helm/flashcards/values-staging.yaml deploy/helm/flashcards/values-prod.yaml
```

🎉 That's the core of week 6: infrastructure from code, two identical environments, merge deploys staging, a person approves prod.

## Step 19: Learn it by breaking it

### 19a. Infrastructure drift

Do what someone does in a hurry: change AWS by hand. Console > **EC2** > **Security Groups** > `flashcards-staging-cluster` > **Edit inbound rules** > **Add rule**: type **Custom TCP**, port **8080**, source **My IP** > **Save rules**.

Now ask Terraform:

```bash
terraform -chdir=infra/terraform/envs/staging plan
```

It found it: `~ update in-place` on the security group, with the 8080 rule marked `-` (to be removed). That's **drift**, same idea as Phase 4's Argo CD self-heal, with one big difference: Argo CD checks every minute by itself, Terraform only checks when someone runs it. Put it back:

```bash
terraform -chdir=infra/terraform/envs/staging apply
```

Real teams run `terraform plan` on a schedule just to catch drift, and the rule is the same as with Argo CD: the fix goes in the code, never only in the console.

### 19b. Staging can't read prod's secrets

Ask External Secrets, running in staging, to fetch prod's database password:

```bash
export KUBECONFIG=~/.kube/flashcards-staging.yaml
kubectl apply -n flashcards-staging -f - <<'EOF'
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: steal-prod
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: SecretStore
    name: aws-secrets-manager
  target:
    name: steal-prod
  dataFrom:
    - extract:
        key: flashcards/prod/db
EOF
```

```bash
kubectl get externalsecret steal-prod -n flashcards-staging
kubectl describe externalsecret steal-prod -n flashcards-staging | tail -5
```

`SecretSyncedError`, and the events say `AccessDeniedException ... is not authorized to perform: secretsmanager:GetSecretValue`. The IAM policy's `flashcards/staging/*` did its job. Clean up:

```bash
kubectl delete externalsecret steal-prod -n flashcards-staging
```

The flip side, and an honest interview answer: *any* pod on the staging VM can read *staging's* secrets, because they all share the VM's role. Known gaps has the fix.

### 19c. Cattle: destroy staging and get it back

The best demo in this phase. Delete the whole environment and rebuild it from code:

```bash
terraform -chdir=infra/terraform/envs/staging destroy
```

The plan shows `25 to destroy`. Type `yes`. About 5 to 10 minutes (RDS again). Then:

```bash
terraform -chdir=infra/terraform/envs/staging apply
```

Wait for the first boot (Step 15), reconnect (Step 16a, the old kubeconfig is useless now, the script fetches a new one), and https://staging.yourdomain.click is back, running exactly what `main` says, smoke test green.

What came back by itself: the network, the VM, Kubernetes, Argo CD, the app at the right version, the certificate, the secrets. What didn't: the old database rows and uploads, because they lived in resources you destroyed. For staging that's fine, that's what staging is for. For prod, it's why real prod databases have backups, deletion protection and snapshots (Known gaps).

## Step 20: Destroy everything 💸

**Every time you finish a session.** Prod first, then staging:

```bash
terraform -chdir=infra/terraform/envs/prod destroy
terraform -chdir=infra/terraform/envs/staging destroy
```

Each shows `25 to destroy`, type `yes`. Then make sure nothing is left running:

```bash
aws ec2 describe-instances --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId'
aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'
```

Both should print `[]`. (A database being deleted can show up for a few minutes, run it again.) Close the tunnel tabs with `Ctrl+C`.

What stays, on purpose: the state bucket, the two Anthropic secrets, the budget, your domain and its zone. About $1.50/month in total.

## Troubleshooting

Same rule as always: look, don't guess. For the cloud, the order is:
1. Did Terraform finish? Re-run `terraform plan`: it should say `No changes`.
2. Did the VM finish booting? `aws ssm start-session` and `sudo tail -100 /var/log/cloud-init-output.log`.
3. Then Kubernetes, exactly like Phase 4: `kubectl get applications -n argocd`, the Argo CD UI, `kubectl describe` and `kubectl logs`.

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Any `aws` or `terraform` command: `ExpiredToken`, `token has expired`, `No valid credential sources` | SSO login expired, or `AWS_PROFILE` not set in this tab | `aws sso login`, and `echo $AWS_PROFILE` says `flashcards` |
| `terraform init`: `S3 bucket "copaaglo-flashcards-tfstate" does not exist` | Bootstrap (Step 5) not applied, or a different AWS account/profile | `aws sts get-caller-identity`, then Step 5 |
| `BucketAlreadyExists` on apply | Someone else in the world already has that bucket name | Pick another name in the `bucket` line (and in the matching `S3_BUCKET` in the values file for uploads buckets) |
| `Error acquiring the state lock` | Another `terraform` is running on that root, or one crashed | Wait for the other one. If it crashed, the error shows a lock ID: `terraform -chdir=... force-unlock <ID>`, only when you're sure nothing else is running |
| `no matching Route 53 Hosted Zone found` | Domain not registered yet, or `domain.tf` has the wrong name | Step 2's check command; `cat infra/terraform/envs/staging/domain.tf` |
| RDS create fails mentioning the engine version or instance class | AWS changed what it offers | `aws rds describe-orderable-db-instance-options --engine postgres --db-instance-class db.t4g.micro --query 'OrderableDBInstanceOptions[].EngineVersion'` and pick a 17.x or 16 |
| `secret with this name is already scheduled for deletion` | A secret deleted with a recovery window (for example after an interrupted destroy) | `aws secretsmanager delete-secret --secret-id flashcards/staging/db --force-delete-without-recovery`, then apply again |
| `aws ssm start-session`: `TargetNotConnected` | VM still booting, or its role isn't attached yet | Wait 1 to 2 minutes. Still failing after 5: console > EC2 > the instance > **Connect** > **Session Manager** tab tells you why |
| `SessionManagerPlugin is not found` | Plugin missing | `brew install --cask session-manager-plugin` |
| cloud-init log ends with an error | A download failed during first boot, usually a timeout | Fix the cause if it's yours, then on the VM: `sudo bash /opt/flashcards/deploy/cloud/bootstrap.sh staging` (it's safe to re-run) |
| `kubectl`: `connection refused` on `127.0.0.1:16443` | Tunnel not running | The `cloud-connect.sh` tab, start it again |
| `kubectl`: certificate or `Unauthorized` errors | Kubeconfig from an older VM (you destroyed and re-applied) | Re-run `cloud-connect.sh`, it fetches the new one |
| ExternalSecret `SecretSyncedError`, describe says `Secret does not exist` | The Anthropic key value was never put in, or the name is wrong | Step 6's `put-secret-value`, then `kubectl annotate externalsecret flashcards-secrets -n flashcards-staging force-sync=$(date +%s) --overwrite` |
| ExternalSecret `SecretSyncedError` with `AccessDenied` | Secret name doesn't start with `flashcards/staging/`, or IAM policy changed | `externalSecrets.prefix` in the values file, the policy in `modules/cluster` |
| ExternalSecret or api: `no EC2 IMDS role found`, `NoCredentialsError` | Pods can't reach the metadata endpoint | `http_put_response_hop_limit = 2` in `modules/cluster`, and the instance profile attached (EC2 console > instance > Security tab) |
| Pods `CreateContainerConfigError` | `flashcards-secrets` doesn't exist yet | Fix the ExternalSecret first (rows above), pods start by themselves once it exists |
| Pods `ImagePullBackOff` with tag `bootstrap` | No release has written a tag yet (or for prod, no promotion) | Step 14's release, or Step 17a's approval |
| api `CrashLoopBackOff`, log says `Invalid endpoint` | Image built before Step 11's change, with `S3_ENDPOINT: ""` | The tag in the values file must be from a commit that includes Step 11 |
| api crash with `AccessDenied` on `HeadBucket` or `CreateBucket` | `S3_BUCKET` in the values file doesn't match Terraform's bucket | `terraform -chdir=infra/terraform/envs/staging output uploads_bucket` vs the values file |
| api or worker: Postgres connection timeout | Database security group | `allowed_security_group_id` in the env's `main.tf` must be the cluster's group |
| Certificate stays `False` | DNS not pointing at the VM yet, or Let's Encrypt can't reach port 80 | `kubectl describe certificate -n flashcards-staging`, `kubectl get challenges -A`, `dig +short staging.$FLASHCARDS_DOMAIN` should print the VM's IP |
| Certificate error says `too many certificates already issued` | Let's Encrypt's limit: 5 certificates for the same name per 7 days, and every rebuild gets a new one | Wait it out, or for that week set `tls.acmeServer: https://acme-staging-v02.api.letsencrypt.org/directory` in the values file (works, but browsers warn) |
| Browser: site can't be found, right after apply | Your Mac cached "no such name" from before the record existed | Wait 15 minutes, or try your phone on mobile data. `dig +short @8.8.8.8 staging.$FLASHCARDS_DOMAIN` shows what the internet sees |
| Promote to prod fails: `Staging runs 'bootstrap'` | No release has updated staging yet | Merge an app change, or Actions > Release > Run workflow |
| Promote to prod runs without waiting for approval | `production` environment has no required reviewers | Step 13b |
| Promote to prod: `Permission denied (publickey)` or push declined | `DEPLOY_KEY` missing from the `production` environment, or key added without write | Step 13a and 13b |
| Budget email never arrives | Budgets update a few times a day; check spam | Billing console > **Budgets** shows the current numbers |

If you get stuck, paste the failing command's output (or the error from the Argo CD UI, or the end of the cloud-init log) in the thread and we'll go through it.

## Daily start and stop

**Start (about 15 minutes until the app is up):**

```bash
cd ~/flashcards
git switch main
git pull
aws sso login
terraform -chdir=infra/terraform/envs/staging apply
```

Add prod only when you're practicing promotions. Then `bash scripts/cloud-connect.sh staging` in its own tab once the first boot finishes. Whatever merged while everything was off deploys automatically, because Argo CD starts from what `main` says.

**Stop, every time:** Step 20. `destroy` prod, `destroy` staging, check with the two `describe` commands.

**Let's Encrypt:** each rebuild gets a fresh certificate, and there's a limit of 5 per name per week. Daily rebuilds of one environment fit; several a day for a week don't (troubleshooting has the workaround).

**If you're done for a while (weeks):** everything except the always-on pieces is gone after Step 20, so there's nothing more to do. To remove even those, `terraform -chdir=infra/terraform/global destroy` removes the budget and the Anthropic secrets. The state bucket stays protected by `prevent_destroy` on purpose.

## Cost check

- **Each environment, while up:** about 6 cents an hour (VM, IP, disk, RDS, one secret).
- **Always on:** about $1.50/month (hosted zone, two secrets, state bucket), plus the domain once a year.
- **LLM calls:** one per staging deploy and one per prod deploy (the smoke tests), plus your own uploads. A cent or two each on the tiny smoke PDF.
- **GitHub Actions and GHCR:** still free (public repo, public packages).
- **The real risk is forgetting.** Both environments left on for a month is about $90. The budget will email you, but only `terraform destroy` stops it.

Check what you've actually spent: AWS console > **Billing and Cost Management** > **Cost Explorer** (data lags about a day). In **Cost allocation tags**, activate `Project` and `Environment`: after a day you can split the bill by the `default_tags` Terraform put on everything.

⚠️ **Before you close your laptop: `terraform destroy` both environments** (Step 20).

## What you have at the end

```
flashcards/
  .gitignore                          + Terraform state, .terraform/, *.tfvars
  .github/workflows/
    ci.yml                            + Lint (terraform)
    release.yml                       staging URL is now https://staging.<domain>
    promote-prod.yml                  NEW: copy staging's tag to prod, after approval
  apps/api/main.py, apps/worker/worker/tasks.py    S3_ENDPOINT optional
  scripts/
    cloud-connect.sh                  NEW: SSM tunnel + kubeconfig for a cloud cluster
  deploy/
    cloud/bootstrap.sh                NEW: first-boot install of cert-manager, External Secrets, Argo CD
    argocd/
      argocd-values.yaml              comments only
      flashcards-staging.yaml         + CreateNamespace
      flashcards-prod.yaml            NEW
    helm/flashcards/
      values.yaml                     + secretKeys, externalSecrets, redis, tls (all off)
      values-staging.yaml             cloud: AWS S3, Secrets Manager, Redis, HTTPS, real host
      values-prod.yaml                same for prod, 2 replicas, tag set by promotion
      templates/api.yaml, worker.yaml secret keys from values
      templates/ingress.yaml          + TLS
      templates/issuer.yaml           NEW: Let's Encrypt
      templates/external-secrets.yaml NEW: SecretStore + ExternalSecret
      templates/redis.yaml            NEW: cloud-only Redis
  infra/terraform/
    bootstrap/                        state bucket (local state)
    global/                           budget + Anthropic key secrets
    modules/vpc, bucket, cluster, database
    envs/staging/, envs/prod/         main.tf, domain.tf, .terraform.lock.hcl
```

Plus, outside Git: a hardened AWS account with SSO, a domain, a `production` GitHub environment with required reviewers and its own deploy key.

## Known gaps (on purpose)

- **One VM per environment.** If it dies, that environment is down until Terraform replaces it. Real setups run several nodes across zones (EKS, or k3s with multiple servers) so one machine can fail without an outage. This is the biggest difference between this setup and a company's.
- **All pods share the VM's IAM role.** Any pod on staging can read staging's secrets and bucket. On EKS, **Pod Identity** (or the older IRSA) gives each Kubernetes service account its own role, so only External Secrets could read secrets and only the api and worker could touch S3.
- **The database password is in Terraform state.** Terraform 1.11+ has **ephemeral resources** and **write-only arguments** (`password_wo` on RDS), which keep it out of state entirely. Another option is RDS-managed passwords, where AWS stores and rotates the password in Secrets Manager itself; then the app needs to pick up rotated passwords without a restart.
- **Secret changes need a pod restart.** External Secrets updates the Secret, but env vars are read at startup. Tools like Reloader restart Deployments when their Secret changes.
- **`sslmode=require` encrypts but doesn't verify RDS's certificate.** `verify-full` with the RDS CA bundle closes that gap.
- **Staging and prod share one AWS account.** Companies use separate accounts per environment (AWS Organizations), so a mistake or a leaked credential in staging can't reach prod at all.
- **Terraform runs from your laptop.** On a team, `terraform plan` runs on every PR and `apply` runs after merge (Atlantis, HCP Terraform, or GitHub Actions authenticating to AWS through **OIDC**, with no stored keys), so infrastructure changes get the same review as code.
- **ECR instead of GHCR.** The plan lists a container registry in Terraform. ECR plus GitHub OIDC is the AWS-native version. GHCR is free and already works, so it stayed.
- **Prod approval is a human check.** The promotion doesn't verify that staging's smoke test passed for that exact SHA. A `/version` endpoint plus a check in `promote-prod.yml` would automate it.
- **Prod data safety is learning-grade:** one day of backups, no deletion protection, no final snapshot, no restore drill. A backup you've never restored is a hope, not a backup.
- **Redis has no password, no persistence, and no NetworkPolicy** keeping other pods away from it.
- **No HTTP to HTTPS redirect, no HSTS.** Plain `http://` still works. A Traefik middleware fixes both.
- **The kubeconfig passes through Systems Manager command output**, which AWS keeps in the Run Command history for a while. Fine for a throwaway learning cluster; a real one would use short-lived credentials (for example OIDC login to the Kubernetes API).
- **Argo CD per cluster, admin user, polling.** Same gaps as Phase 4, now on the internet-facing clusters (the UI itself is only reachable through your tunnel, which helps).
- **The VM runs `bootstrap.sh` from whatever is on `main` when it boots.** Pinning the first boot to a reviewed commit or a release tag would be stricter.

## Interview talking points from this phase

- "Staging and prod are built by Terraform from shared modules, so they differ only in size and names. I can destroy an environment and rebuild it from code in about 15 minutes, and Argo CD redeploys the app from Git by itself."
- "Terraform state is in a versioned, private S3 bucket with native lock files, split into roots by environment so a destroy in staging can't touch prod."
- "There are no AWS access keys anywhere: I log in with IAM Identity Center, CI never talks to AWS, and pods get temporary credentials from the VM's IAM role through IMDSv2."
- "Secrets live in AWS Secrets Manager. External Secrets builds the Kubernetes Secret from them, including assembling the database URL from the password Terraform generated. No human ever saw the database password."
- "IAM is scoped per environment: I tested that the staging cluster gets AccessDenied reading prod's secrets. I also know the gap: all pods on a node share the role, and Pod Identity on EKS fixes that."
- "I chose k3s on a VM over EKS for cost: EKS is about $73 a month before any machines. Same Kubernetes API, so the Helm chart and Argo CD setup are identical, and moving to EKS is a Terraform change, not an app change."
- "No SSH: the security group only opens 80 and 443. I get a shell and a Kubernetes API tunnel through AWS Systems Manager, which checks my IAM login."
- "The database is in private subnets with no internet route, and its security group only allows the cluster's security group. No NAT gateway, because nothing private needs to reach out, which also saves about $33 a month."
- "HTTPS is automatic: cert-manager gets Let's Encrypt certificates through an HTTP-01 challenge and renews them. I hit Let's Encrypt's rate limits when rebuilding often and know the workaround."
- "Prod promotion is a GitHub Environment with required reviewers. The workflow copies the exact image SHA from staging, so prod only ever runs images that ran on staging first, and the approval is recorded."
- "I caught infrastructure drift with `terraform plan` after changing a security group by hand, and know the difference from Argo CD's continuous self-heal."
- "I set up a budget alarm before creating anything, and every resource carries `Project` and `Environment` tags, so the bill splits by environment."

Once a change has gone from PR to staging to an approved prod deploy, and you've done the Step 19 drift, access and rebuild exercises, you're done with week 6. Next up is week 7: AI evals in CI, monitoring with Prometheus and Grafana, and KEDA scaling the workers on queue length.

⚠️ **Last reminder: `terraform destroy` prod and staging (Step 20) before you walk away.**
