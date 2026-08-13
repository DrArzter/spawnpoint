variable "aws_region" {
  description = "AWS region containing the game host and its zonal data volume."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "The measured player region and current data lineage are fixed to eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used for local Terraform operations; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "availability_zone" {
  description = "Account-specific AZ name corresponding to availability_zone_id."
  type        = string
  default     = "eu-central-1a"
}

variable "availability_zone_id" {
  description = "Stable physical AZ identifier; protects against account-specific AZ name remapping."
  type        = string
  default     = "euc1-az2"
}

variable "instance_type" {
  description = "Free-plan host now; promote to r8i-flex.large only after an explicit paid-plan decision."
  type        = string
  default     = "m7i-flex.large"

  validation {
    condition     = contains(["m7i-flex.large", "r8i-flex.large"], var.instance_type)
    error_message = "Use the measured free-plan shape or the reviewed 16 GiB upgrade; price any other type first."
  }
}

variable "data_volume_size_gib" {
  description = "Persistent world, release and session-data volume size."
  type        = number
  default     = 20

  validation {
    condition     = var.data_volume_size_gib >= 20
    error_message = "Do not shrink below the measured 20 GiB starting size. EBS volumes cannot shrink in place."
  }
}

