# AWS Mini App hosting command log

Executed on 2026-08-27 against account `614934752397`, profile `spawnpoint`.
This root is static hosting only and has no IAM permission or dependency on
EC2, Lambda, DynamoDB or Step Functions.

## Resources

| Resource | Value | Purpose |
| --- | --- | --- |
| S3 bucket | `spawnpoint-web-614934752397` | Private static origin |
| CloudFront distribution | `E1UUZEI6NMXTB7` | Public HTTPS edge |
| CloudFront OAC | `E2FAI8E37LEOYC` | Signed read-only requests to S3 |
| Mini App URL | `https://dwk99t8cin0cf.cloudfront.net/` | Telegram/browser entry point |

The bucket has owner-enforced object ownership, AES-256 server-side
encryption and all four Public Access Block switches enabled. Its policy is
not public: only the exact CloudFront distribution may read objects. The
distribution uses `PriceClass_100`, HTTPS redirects, compression, HTTP/2 and
HTTP/3, AWS's managed optimized cache policy and managed security headers.

## Infrastructure deployment

```bash
terraform -chdir=infra/terraform-web init \
  -reconfigure -backend-config=backend.hcl
terraform -chdir=infra/terraform-web test
terraform -chdir=infra/terraform-web validate
terraform -chdir=infra/terraform-web plan -out=web.tfplan
terraform -chdir=infra/terraform-web apply web.tfplan
terraform -chdir=infra/terraform-web plan -detailed-exitcode
```

The reviewed plan and apply were exactly `7 add / 0 change / 0 destroy`.
The final plan returned `No changes`. The standard CloudFront domain uses its
AWS-managed certificate; choosing its minimum TLS policy is only available
with a custom domain and ACM certificate, so Terraform intentionally does not
claim to configure that unsupported setting.

## Content deployment

```bash
TERRAFORM_BIN=terraform \
AWS_PROFILE_NAME=spawnpoint \
AWS_REGION_NAME=eu-central-1 \
scripts/deploy-web.sh
```

On a workstation without Terraform CLI, pass the already reviewed outputs
explicitly; the upload path remains identical and still touches only static
objects in the dedicated web bucket:

```bash
WEB_BUCKET_NAME=spawnpoint-web-614934752397 \
MINI_APP_URL=https://dwk99t8cin0cf.cloudfront.net/ \
AWS_PROFILE_NAME=spawnpoint \
AWS_REGION_NAME=eu-central-1 \
scripts/deploy-web.sh
```

The script runs the TypeScript/Vite production build, resolves the dedicated
bucket and URL from Terraform outputs, synchronizes only `dist/assets` and
uploads `index.html`. Hashed assets receive an immutable one-year cache;
`index.html` receives `no-cache`, so ordinary deployments need no CloudFront
invalidation.

Acceptance on 2026-08-27:

- CloudFront returned HTTP 200 with HSTS, `nosniff`, `SAMEORIGIN` and a strict
  referrer policy;
- S3 reported `IsPublic=false` and all Public Access Block switches `true`;
- the production React application rendered with no browser warnings/errors;
- the Start button remained disabled and no AWS control-plane API existed.

## Telegram entry point

The existing command bot received public environment value `MINI_APP_URL` and
an `Open panel` `web_app` button at the top of its safe `/start` menu. The bot
plan and apply were exactly `0 add / 1 change / 0 destroy`, changing only the
existing Lambda bundle and that environment value. A signed `/start` smoke
returned HTTP 200, the Lambda logs contained no application error, Terraform
returned `No changes`, and EC2 remained `stopped`.

Telegram Desktop on Linux needs WebKitGTK to render Mini Apps. On the owner's
CachyOS/Arch workstation the required package is `webkit2gtk-4.1`; after
installation Telegram Desktop must be fully restarted. This is a client
runtime dependency, not an AWS or Mini App deployment failure.
