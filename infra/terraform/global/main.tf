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
    # Zips the kill switch Lambda's code (kill-switch.tf)
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
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
