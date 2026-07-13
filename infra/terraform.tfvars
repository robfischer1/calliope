# calliope — the ONE sovereign /infra file (tofu auto-loads terraform.tfvars).
# Coupled cutover: the bun-mcp star on stellar_core:bun-mcp + the Pistis identity
# plane. DB password boot-fetched from Calypso /fleet via the SPIRE SVID (identity
# star-calliope). The image is rob/calliope (fleet convention, repo name). The
# CONTAINER is named calliope-mcp so hades reaches it at calliope-mcp:8204 (the
# hades_straggler_routes fallback, which merge-overrides the contract row; the
# poured root /infra passes container_name but not aliases). verb_prefix is
# omitted (null) — calliope serves BARE prose verbs (hades_bare_verb_stars).
# FOLLOW-UP: retire calliope+urania from hades_straggler_routes so the contract
# row (calliope:8204) is authoritative, then this container_name can drop.
name             = "calliope"
container_name   = "calliope-mcp"
image            = "forgejo.notusmi.com/rob/calliope@sha256:c6fc87231a22d2af5851c845ada273a2104b735449e9581d453a7554ea539e8b"
listen_port      = 8204
extra_networks   = ["mnemosyne-net", "pantheon"]
private_networks = []

labels = { "pistis.star" = "calliope" }
volumes = [
  { container_path = "/run/spire/agent/public", host_path = "/srv/spire/agent/public", read_only = false },
]

env = {
  HOST       = "0.0.0.0"
  PORT       = "8204"
  CHAOS_URL  = "http://chaos:8206"
  URANIA_URL = "http://urania:8202"

  # Pistis boot-fetch: stellar-boot logs into Calypso with the JWT-SVID and
  # `infisical run`s the per-star folder — SELECTION and ASSEMBLY both live in
  # Calypso now. /fleet/calliope holds CALLIOPE_DB_PASSWORD (a cross-folder
  # reference to the flat /fleet value, so rotation still flows) and DATABASE_URL
  # (a folder-local reference that --expand resolves) — the composite the retired
  # STELLAR_ENV_TEMPLATE used to render. The app reads a bare DATABASE_URL
  # (apps/calliope/src/mcp/backend.ts), so the folder key carries that exact name.
  # STELLAR_SECRET_MAP / STELLAR_ENV_TEMPLATE are RETIRED — the new stellar-boot
  # FAIL-CLOSES if either is set. star-calliope is SPIRE-bound (Pistis F3).
  CALYPSO_IDENTITY_ID  = "e85c0a9c-f412-4cce-8e53-3dc8c7df92e5"
  CALYPSO_URL          = "https://calypso.notusmi.com"
  CALYPSO_WORKSPACE_ID = "107e672d-b7bd-4f94-b181-169e02fc7253"
  STELLAR_SECRET_PATH  = "/fleet/calliope"
}
