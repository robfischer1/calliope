# CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit. Mirrors the shared
# `modules/star` input surface so a star's terraform.tfvars sets only what it needs;
# every input is defaulted (a minimal star sets just name + image + verb_prefix).
# When the star module gains an input, add it here + in main.tf's pass-through.

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
