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
