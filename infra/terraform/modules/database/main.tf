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
