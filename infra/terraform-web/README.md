# Spawnpoint panel hosting

This isolated root owns the static panel hosting attached to the public domain:
one private S3 bucket, one CloudFront Origin Access Control, one distribution,
its `us-east-1` ACM viewer certificate and the Route 53 validation plus A/AAAA
alias records. The delegated hosted zone itself remains in `terraform-domain`,
so removing a web surface cannot remove authoritative DNS. This root cannot
start EC2 or modify lifecycle workflows; there is no WAF or always-running
process.

```bash
cp backend.hcl.example backend.hcl
terraform init -backend-config=backend.hcl
terraform test
terraform plan -var='domain_name=spawnpoint.example.dev' -out=web.tfplan
terraform apply web.tfplan
../../scripts/deploy-web.sh
```

The bucket stays private and rejects direct public access. CloudFront is the
only reader. Hashed assets receive a one-year immutable cache header; the small
`index.html` is revalidated so new builds become visible without an expensive
full-distribution invalidation.

CloudFront requires its ACM viewer certificate in `us-east-1`; the aliased
provider is deliberately fixed to that AWS edge-service region while the S3
origin stays in `aws_region`. The hostname itself has no default and comes from
the caller. DNS validation renews automatically while its Terraform-managed
CNAME remains in the delegated zone.
