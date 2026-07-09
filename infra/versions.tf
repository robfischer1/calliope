# CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit; a divergence is
# restored on the next core apply. The star's spec is terraform.tfvars (sovereign).
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}
