locals {
  name = "hubspot-ad-campaign"

  hubspot_secret_id    = "hubspot-sensitive-properties-private-app-token"
  hubspot_secret_field = "HS_AUTH_TOKEN"
  secret_arns = [
    "arn:aws:secretsmanager:ca-central-1:343012924431:secret:${local.hubspot_secret_id}-*",
  ]
}

# The repo with its production node_modules (`npm ci --omit=dev`), without the infra and local files.
data "archive_file" "function" {
  type        = "zip"
  source_dir  = "${path.module}/../.."
  output_path = "${path.module}/function.zip"
  excludes = [
    ".git",
    ".env",
    ".DS_Store",
    ".gitignore",
    "README.md",
    "infra",
  ]
}

resource "aws_iam_role" "function" {
  name = "${local.name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.function.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "secrets" {
  name = "read-secrets"
  role = aws_iam_role.function.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = local.secret_arns
    }]
  })
}

resource "aws_cloudwatch_log_group" "function" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}

# Writes the ad campaign properties onto the contacts in every ad segment.
resource "aws_lambda_function" "function" {
  function_name    = local.name
  role             = aws_iam_role.function.arn
  runtime          = "nodejs22.x"
  handler          = "lambda.handler"
  filename         = data.archive_file.function.output_path
  source_code_hash = data.archive_file.function.output_base64sha256
  timeout          = 900
  memory_size      = 256

  environment {
    variables = {
      HUBSPOT_SECRET_ID    = local.hubspot_secret_id
      HUBSPOT_SECRET_FIELD = local.hubspot_secret_field
    }
  }

  depends_on = [aws_cloudwatch_log_group.function]
}

# Runs the update every hour, on the hour, Toronto time.
resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "invoke-function"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.function.arn
    }]
  })
}

resource "aws_scheduler_schedule" "hourly" {
  name                         = "${local.name}-hourly"
  schedule_expression          = "cron(0 * * * ? *)"
  schedule_expression_timezone = "America/Toronto"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.function.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({})

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
