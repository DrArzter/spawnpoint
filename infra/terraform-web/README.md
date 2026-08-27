# Telegram Mini App hosting

This isolated root owns only the static Mini App hosting: one private S3
bucket, one CloudFront Origin Access Control and one HTTPS distribution. It
cannot start EC2 or modify lifecycle workflows. There is no WAF, Route 53 zone,
custom certificate or always-running process.

```bash
cp backend.hcl.example backend.hcl
terraform init -backend-config=backend.hcl
terraform test
terraform plan -out=web.tfplan
terraform apply web.tfplan
../../scripts/deploy-web.sh
```

The bucket stays private and rejects direct public access. CloudFront is the
only reader. Hashed assets receive a one-year immutable cache header; the small
`index.html` is revalidated so new builds become visible without an expensive
full-distribution invalidation.
