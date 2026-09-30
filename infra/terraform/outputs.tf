output "function_name" {
  value = aws_lambda_function.function.function_name
}

output "schedule" {
  value = "${aws_scheduler_schedule.hourly.schedule_expression} ${aws_scheduler_schedule.hourly.schedule_expression_timezone}"
}
