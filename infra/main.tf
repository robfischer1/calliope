# Canonical per-repo /infra (Smaller Hammers F1 — the reference F8 genesis + the
# per-repo child instantiate). This file is GENERIC and identical across every
# star: a thin pass-through caller of the shared `modules/star`, taking the star's
# spec from `var.*` (a per-repo terraform.tfvars — the one sovereign file) and its
# wiring from the telescope contract.
#
# CONSOLIDATED (Smaller Hammers F14): the terraform/provider block, the variable
# surface, and the roster output that used to live in versions.tf / providers.tf /
# variables.tf / outputs.tf are folded HERE, so a star's whole /infra is just
# backend.tf + main.tf (+ the sovereign terraform.tfvars) — the same lean shape as
# a frontend leaf. tofu concatenates every *.tf in a dir, so this is a pure
# file-organization change: byte-identical behavior to the old five-file split.
#
# CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit; a divergence is
# restored on the next core apply. The star's spec is terraform.tfvars (sovereign).
#
# The module `source` is a git ref pinned FLEET-WIDE (a version bump re-pours to
# every star at once — one reviewable change, no per-repo drift, which is the F1
# anti-drift intent). tofu forbids a variable in `source`, so the ref is baked in
# here, not per-repo. A backend swap (docker -> k8s / AWS) is an edit in
# modules/star, not a repour of this file.

terraform {
  required_version = ">= 1.8.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
    infisical = {
      source  = "infisical/infisical"
      version = "~> 0.15"
    }
  }
}

variable "docker_host" {
  description = "Docker daemon endpoint (the deploy pipeline runs on the nas01 runner and exports TF_VAR_docker_host=unix:///var/run/docker.sock)."
  type        = string
  default     = "unix:///var/run/docker.sock"
}

provider "docker" {
  host = var.docker_host
}

# PROVIDER PIVOT: container secrets read declaratively from Calypso
# via the tofu Infisical provider — no bespoke curl-materialize, no boot-time fetch.
# Zero-cred: deploy.yml mints a Forgejo OIDC id-token (aud=calypso) into
# INFISICAL_AUTH_JWT; the provider exchanges it itself for a short-lived Calypso token.
variable "calypso_identity_id" {
  description = "The ci-<star> Calypso OIDC identity id (Forgejo var CI_OIDC_IDENTITY_ID). Non-secret."
  type        = string
}

provider "infisical" {
  host = "https://calypso.notusmi.com"
  auth = {
    oidc = {
      identity_id                     = var.calypso_identity_id
      token_environment_variable_name = "INFISICAL_AUTH_JWT"
    }
  }
}

# The star's own secret folder — only its keys enter this repo's state (least-privilege).
data "infisical_secrets" "fleet" {
  env_slug     = "prod"
  workspace_id = "107e672d-b7bd-4f94-b181-169e02fc7253"
  folder_path  = "/fleet/${var.name}"
}

locals {
  # Wiring comes from the telescope contract: the deploy pipeline oras-pulls the
  # signed epoch, cosign-verifies it, and materializes it as fleet.json (gitignored)
  # before every plan/apply. No repo reads the core state (F3 sole-reader rule).
  fleet = jsondecode(file("${path.module}/fleet.json"))

  # Every star joins the fleet's shared mesh network; a star needing more (e.g. the
  # internal forgejo net to clone repos) lists them in var.extra_networks.
  networks = concat([local.fleet.network], var.extra_networks)
}

module "star" {
  source = "git::https://forgejo.notusmi.com/rob/infra.git//star?ref=9f57fdfd7a425ccacab82925b8aefe7ee29745d1"

  name             = var.name
  container_name   = var.container_name
  image            = var.image
  env              = var.env
  networks         = local.networks
  ports            = var.ports
  private_networks = var.private_networks
  volumes          = var.volumes
  labels           = var.labels
  command          = var.command
  db               = var.db
  stores           = var.stores
  apps             = var.apps
  extra_hosts      = var.extra_hosts

  # Roster contract (F1 -> F3): the fields hephaestus projects into telescope.
  verb_prefix = var.verb_prefix
  topics      = var.topics
  listen_port = var.listen_port
  extras      = var.extras

  # F4: the app boots with its Pistis identity and pulls its OWN secrets from
  # Calypso -- so a plain MCP star injects nothing (var.secrets defaults {}). The
  # exception is a sovereign DB: its postgres co-container needs POSTGRES_PASSWORD
  # as a plain env at create (postgres is not a Pistis client), so a DB star's
  # deploy passes it via TF_VAR_secrets (from the repo's own Actions secret) and
  # the ${..._DB_PASSWORD} refs in its tfvars resolve from here.
  # PIVOT: secrets now come from Calypso via the Infisical provider (was var.secrets,
  # CI-materialized). The module's ${SECRET} substitution is unchanged.
  secrets = { for k, v in data.infisical_secrets.fleet.secrets : k => v.value }

  # F6: the SPIRE/Calypso identity binding. null = a legacy injected-creds star;
  # set via the foundry-owned infra/pistis.auto.tfvars overlay once the star's
  # identity is minted. The module attaches the label + socket + boot env.
  pistis = var.pistis
}

# The blessed roster row, re-exposed at the root so hephaestus's F3 projection reads
# it from this repo's state (pg schema = repo).
output "star" {
  description = "The star's roster row for telescope (the F1->F3 contract)."
  value       = module.star.star
}

# --- Input surface (mirrors the shared modules/star inputs) -------------------
# Every input is defaulted bar name/image (a minimal star sets just name + image +
# verb_prefix). When the star module gains an input, add it here + in the module
# pass-through above.

variable "name" {
  description = "The star name (= repo name = the backend schema_name = default container name)."
  type        = string
}

variable "container_name" {
  description = "Container-name override when it differs from the star key (rare). Empty = use name."
  type        = string
  default     = ""
}

variable "image" {
  description = "The sha-pinned image ref (forgejo.notusmi.com/rob/<star>@sha256:...), from the build step."
  type        = string
}

variable "env" {
  description = "Container env KEY => VALUE. F4 boots via Pistis, so a sovereign MCP star usually needs only its own HOST/PORT/DB-URL wiring here."
  type        = map(string)
  default     = {}
}

variable "extra_networks" {
  description = "External networks this star joins BEYOND the fleet's shared mesh (e.g. the internal forgejo net). The mesh network is always attached (from fleet.json)."
  type        = list(string)
  default     = []
}

variable "private_networks" {
  description = "Per-star private networks the module declares as {name}_{net} (e.g. a sovereign DB link)."
  type        = list(string)
  default     = []
}

variable "ports" {
  description = "Published host ports. EMPTY for a sovereign MCP star (Hades is its only edge); set only for a substrate star with binary-TCP listeners."
  type = list(object({
    internal = number
    external = number
    protocol = optional(string, "tcp")
  }))
  default = []
}

variable "volumes" {
  description = "Named/bind volume mounts (a named volume is adopted by name, never declared — survives destroy)."
  type = list(object({
    container_path = string
    host_path      = optional(string)
    volume_name    = optional(string)
    read_only      = optional(bool, false)
  }))
  default = []
}

variable "labels" {
  description = "Container labels as KEY => VALUE. Empty (default) manages none — a fleet-safe no-op. A star opts in when an out-of-band consumer keys off a label (e.g. SPIRE docker attestation: docker:label:pistis.star:<name>)."
  type        = map(string)
  default     = {}
}

variable "command" {
  description = "Container command override (upstream-image stars). Empty = the image's baked entrypoint."
  type        = list(string)
  default     = []
}

variable "db" {
  description = "Optional sovereign DB co-container (the star module's db object) — a postgres on a private net with a named volume adopted by name + prevent_destroy. null = a DB-less star."
  type        = any
  default     = null
}

variable "stores" {
  description = "Additional backing stores beyond the one sovereign var.db (e.g. a Calypso Redis). Keyed by store name. {} = none."
  type        = any
  default     = {}
}

variable "apps" {
  description = "C7 hybrid-star attached control-plane apps that run beside a substrate in this root. Keyed by verb_prefix. {} = none."
  type        = any
  default     = {}
}

variable "extra_hosts" {
  description = "Static host => IP pins added to the container's /etc/hosts (the F4 tailnet-name case). {} = none."
  type        = map(string)
  default     = {}
}

variable "verb_prefix" {
  description = "Hades verb namespace; null for a non-MCP star (broker, frontend)."
  type        = string
  default     = null
}

variable "topics" {
  description = "Event topics this star produces/consumes, for the roster. [] if none."
  type        = list(string)
  default     = []
}

variable "listen_port" {
  description = "Internal east-west listen port Hades dials by name (DERIVED upstream — Hephaestus port window). null = no dialable port."
  type        = number
  default     = null
}

variable "extras" {
  description = "Open map for star-specific roster fields outside the fixed shape (e.g. a broker's registry_addr). {} for a plain star."
  type        = map(any)
  default     = {}
}

variable "secrets" {
  description = "Sensitive values for secret-reference interpolation in env / the db block (a sovereign DB's password). The deploy assembles this from the repo's TF_VAR_SECRETS Actions secret (a JSON map); {} for a Pistis-only star (the common case). Never committed -- it flows via TF_VAR_secrets at plan/apply."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "pistis" {
  description = "Pistis F6 identity binding — SPIRE-attested boot-time secret fetch (zero injected app creds). null (default) = a legacy injected-creds star (byte-identical to pre-Pistis). Set via the foundry-owned infra/pistis.auto.tfvars overlay (rendered by hephaestus once the star's Calypso identity is minted); the operator's terraform.tfvars stays clean. Mirrors the shared modules/star `pistis` input."
  type = object({
    identity_id           = string
    workspace_id          = optional(string, "107e672d-b7bd-4f94-b181-169e02fc7253")
    calypso_url           = optional(string, "https://calypso.notusmi.com")
    secret_path           = optional(string, "/fleet")
    secret_map            = optional(map(string), {})
    env_template          = optional(map(string), {})
    socket_host_path      = optional(string, "/srv/spire/agent/public")
    socket_container_path = optional(string, "/run/spire/agent/public")
  })
  default = null
}
