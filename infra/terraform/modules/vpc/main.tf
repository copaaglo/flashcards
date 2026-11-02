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
