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
