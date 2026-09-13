# Domain DNS

This root owns the delegated public Route 53 hosted zone for Spawnpoint. Namecheap remains the registrar and the
authoritative DNS provider for the parent personal domain. One `NS` record at Namecheap delegates only
`spawnpoint.drarzter.dev` to the four Route 53 nameservers.

This boundary leaves apex mail and unrelated personal or VPS records outside the Spawnpoint repository. Inside the
delegated zone, records may independently expose the dashboard at `spawnpoint.drarzter.dev`, the game at
`minecraft.spawnpoint.drarzter.dev`, the API or a status surface. The zone is also separate from `terraform-web`:
deleting or replacing the site must never own project DNS. Terraform prevents destruction of the zone, and the
production deployment role has no `route53:DeleteHostedZone` permission.

The first apply creates only the hosted zone and prints its nameservers. It does not change live DNS. Add those values
as `NS` records for the `spawnpoint` host in Namecheap Advanced DNS, wait for delegation to resolve, and only then
attach CloudFront and other project records in later reviewed changes. Do not replace the parent domain's nameservers.

The root contains no production domain or region default. CI supplies `TF_VAR_domain_name` and `TF_VAR_aws_region`
from the repository variables `SPAWNPOINT_DOMAIN` and `AWS_REGION`; local runs provide the same environment variables
or an ignored `.tfvars` file. The remote state bucket comes from `TF_STATE_BUCKET` rather than this root.

Route 53 charges for a public hosted zone even when it contains no custom records. See the current price in the
[AWS Route 53 pricing page](https://aws.amazon.com/route53/pricing/).
