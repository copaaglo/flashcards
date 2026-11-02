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
