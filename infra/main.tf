# Canonical per-repo /infra (Smaller Hammers F1 — the reference F8 genesis + the
# per-repo child instantiate). This file is GENERIC and identical across every
# star: it is a thin pass-through caller of the shared `modules/star`, taking the
# star's spec from `var.*` (a per-repo terraform.tfvars — the one sovereign file)
# and its wiring from the telescope contract.
#
# CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit; a divergence is
# restored on the next core apply. The star's spec is terraform.tfvars (sovereign).
#
# The module `source` is a git ref pinned FLEET-WIDE (a version bump re-pours to
# every star at once — one reviewable change, no per-repo drift, which is the F1
# anti-drift intent). tofu forbids a variable in `source`, so the ref is baked in
# here, not per-repo.

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
  source = "git::https://forgejo.notusmi.com/rob/foundry.git//infra/star?ref=b340c29922848eb865625101b39e5b4dc76b778c"

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
  secrets = var.secrets

  # F6: the SPIRE/Calypso identity binding. null = a legacy injected-creds star;
  # set via the foundry-owned infra/pistis.auto.tfvars overlay once the star's
  # identity is minted. The module attaches the label + socket + boot env.
  pistis = var.pistis
}
