# calliope — the frontend's deploy spec (the ONE sovereign file; not poured).
# main.tf + backend.tf are centrally poured (foundry ci.tf, kind=frontend); this
# file is yours. Bump `image` to a published @sha256 digest to deploy a new build.
name           = "calliope"
image          = "forgejo.notusmi.com/rob/calliope:latest"
runtime        = "static"
host_ip        = "127.0.0.1"
host_port      = 8204
container_port = 8204
