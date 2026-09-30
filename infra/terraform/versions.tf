terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region              = "ca-central-1"
  allowed_account_ids = ["343012924431"]

  default_tags {
    tags = {
      Project   = "hubspot-ad-campaign"
      ManagedBy = "terraform"
    }
  }
}
