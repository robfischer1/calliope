terraform {
  # Per-repo ISOLATED state (Smaller Hammers F1). The isolation key is the pg
  # backend `schema_name` = this repo's name, supplied at init:
  #   tofu init \
  #     -backend-config="conn_str=$PG_CONN_STR" \
  #     -backend-config="schema_name=<repo>"
  # Physically co-located in DB `tofu`, logically isolated — a star's state advances
  # only from its own PRs (the merge-if-clean enabler). Distinct from the foundry
  # core-root state (default schema).
  #
  # CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit; a divergence is
  # restored on the next core apply. The star's spec is terraform.tfvars (sovereign).
  backend "pg" {}
}
