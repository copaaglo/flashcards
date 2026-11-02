# A safety net for forgetting terraform destroy: when this month's actual spend passes
# kill_switch_usd, AWS Budgets publishes to an SNS topic, and a small Lambda stops every
# running EC2 VM and RDS database tagged Project = flashcards.
#
# Stopped is not deleted: disks, buckets, secrets and the DNS zone still cost a little,
# and AWS starts a stopped RDS again after 7 days. terraform destroy is still the off switch.
# Billing data lags a few hours, so this is a safety net, not an exact cap.

variable "kill_switch_usd" {
  description = "Monthly actual spend that stops all flashcards VMs and databases"
  type        = number
  default     = 10
}

resource "aws_sns_topic" "kill_switch" {
  name = "flashcards-budget-kill-switch"
}

# Only AWS Budgets, for this account, may publish to the topic
resource "aws_sns_topic_policy" "kill_switch" {
  arn = aws_sns_topic.kill_switch.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowBudgetsToPublish"
      Effect    = "Allow"
      Principal = { Service = "budgets.amazonaws.com" }
      Action    = "SNS:Publish"
      Resource  = aws_sns_topic.kill_switch.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

data "aws_caller_identity" "current" {}

resource "aws_budgets_budget" "kill_switch" {
  name         = "flashcards-kill-switch"
  budget_type  = "COST"
  limit_amount = tostring(var.kill_switch_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Actual spend only. A forecast can be wrong, and stopping things on a guess is too much.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.kill_switch.arn]
  }

  depends_on = [aws_sns_topic_policy.kill_switch]
}

# --- The Lambda that does the stopping ----------------------------------------

data "archive_file" "kill_switch" {
  type        = "zip"
  source_file = "${path.module}/kill_switch.py"
  output_path = "${path.module}/.terraform/kill_switch.zip"
}

resource "aws_iam_role" "kill_switch" {
  name = "flashcards-kill-switch"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "kill_switch_logs" {
  role       = aws_iam_role.kill_switch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Find anything, but only stop things tagged Project = flashcards
resource "aws_iam_role_policy" "kill_switch" {
  name = "stop-flashcards"
  role = aws_iam_role.kill_switch.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Find"
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "rds:DescribeDBInstances"]
        Resource = "*"
      },
      {
        Sid       = "StopFlashcardsVMs"
        Effect    = "Allow"
        Action    = "ec2:StopInstances"
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "flashcards" } }
      },
      {
        Sid       = "StopFlashcardsDatabases"
        Effect    = "Allow"
        Action    = "rds:StopDBInstance"
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceTag/Project" = "flashcards" } }
      },
    ]
  })
}

resource "aws_lambda_function" "kill_switch" {
  function_name    = "flashcards-kill-switch"
  role             = aws_iam_role.kill_switch.arn
  runtime          = "python3.13"
  handler          = "kill_switch.handler"
  filename         = data.archive_file.kill_switch.output_path
  source_code_hash = data.archive_file.kill_switch.output_base64sha256
  timeout          = 60
}

resource "aws_lambda_permission" "kill_switch" {
  statement_id  = "AllowSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.kill_switch.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.kill_switch.arn
}

resource "aws_sns_topic_subscription" "kill_switch" {
  topic_arn = aws_sns_topic.kill_switch.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.kill_switch.arn
}

output "kill_switch_function" {
  value = aws_lambda_function.kill_switch.function_name
}
