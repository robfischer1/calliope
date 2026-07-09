# CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit; a divergence is
# restored on the next core apply. The star's spec is terraform.tfvars (sovereign).
variable "docker_host" {
  description = "Docker daemon endpoint (the deploy pipeline runs on the nas01 runner and exports TF_VAR_docker_host=unix:///var/run/docker.sock)."
  type        = string
  default     = "unix:///var/run/docker.sock"
}

provider "docker" {
  host = var.docker_host
}
