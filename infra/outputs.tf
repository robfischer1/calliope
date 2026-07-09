# The blessed roster row, re-exposed at the root so hephaestus's F3 projection reads
# it from this repo's state (pg schema = repo).
#
# CENTRALLY POURED (foundry infra/ci.tf) — do not hand-edit; a divergence is
# restored on the next core apply. The star's spec is terraform.tfvars (sovereign).
output "star" {
  description = "The star's roster row for telescope (the F1->F3 contract)."
  value       = module.star.star
}
