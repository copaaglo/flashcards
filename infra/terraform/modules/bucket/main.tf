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
