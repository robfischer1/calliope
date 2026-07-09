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
image            = "forgejo.notusmi.com/rob/calliope@sha256:cf067fce8db76e4df5a8d99f46763cd8f46d9f1629741e5d8963ad1fc14024ff"
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

  # Pistis boot-fetch: stellar-boot logs into Calypso with the JWT-SVID, reads
  # CALLIOPE_DB_PASSWORD from /fleet, materializes DATABASE_URL from the template.
  CALYPSO_IDENTITY_ID  = "e85c0a9c-f412-4cce-8e53-3dc8c7df92e5"
  CALYPSO_URL          = "https://calypso.notusmi.com"
  CALYPSO_WORKSPACE_ID = "107e672d-b7bd-4f94-b181-169e02fc7253"
  STELLAR_SECRET_PATH  = "/fleet"
  STELLAR_SECRET_MAP   = "{\"CALLIOPE_DB_PASSWORD\":\"CALLIOPE_DB_PASSWORD\"}"
  STELLAR_ENV_TEMPLATE = "{\"DATABASE_URL\":\"postgresql://calliope:{CALLIOPE_DB_PASSWORD}@postgres-postgres-1:5432/calliope\"}"
}
